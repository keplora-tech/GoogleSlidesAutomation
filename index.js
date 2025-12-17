#!/usr/bin/env node
import fs from "fs";
import readline from "readline";
import open from "open";
import { google } from "googleapis";

const TEMPLATE_ID = "1ahZSamvvym7WV6Rc7YMlpRNXAd3itlEzbkUcQ3aY25U";
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/presentations"
];
const TOKEN_PATH = "token.json";

// Load OAuth credentials
function loadCredentials() {
  const content = fs.readFileSync("credentials.json");
  const { client_secret, client_id, redirect_uris } = JSON.parse(content).web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Authorize user (OAuth)
async function authorize() {
  const oAuth2Client = loadCredentials();
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  console.log("Authorize here:", authUrl);
  await open(authUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve =>
    rl.question("Paste full URL here: ", answer => {
      rl.close();
      resolve(answer.split("code=")[1]?.split("&")[0].trim());
    })
  );

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  return oAuth2Client;
}

// Copy template to new presentation
async function copyTemplate(drive, newName) {
  const copy = await drive.files.copy({ fileId: TEMPLATE_ID, requestBody: { name: newName } });
  return copy.data.id;
}

// Dump template structure in correct format
async function dumpTemplate(slides, templateId) {
  const presentation = await slides.presentations.get({ presentationId: templateId });

  return presentation.data.slides.map(slide => {
    const elements = [];

    if (slide.pageElements) {
      for (const element of slide.pageElements) {
        if (element.shape && element.shape.text && element.shape.text.textElements) {
          const text = element.shape.text.textElements
            .map(te => te.textRun?.content || "")
            .join("");

          elements.push({
            objectId: element.objectId,
            text: text
          });
        }
      }
    }

    return {
      slideId: slide.objectId,
      elements: elements
    };
  });
}

// Reset presentation to match template structure
async function resetPresentationToTemplate(slides, presentationId, templateId) {
  console.log("Resetting presentation to template state...");

  // Get both presentations
  let currentPres, templatePres;
  try {
    [currentPres, templatePres] = await Promise.all([
      slides.presentations.get({ presentationId }),
      slides.presentations.get({ presentationId: templateId })
    ]);
  } catch (error) {
    console.error("Error fetching presentations:", error.message);
    throw error;
  }

  if (!currentPres.data || !templatePres.data) {
    throw new Error("Failed to fetch presentation data");
  }

  const requests = [];

  // Delete all existing slides
  if (currentPres.data.slides && currentPres.data.slides.length > 0) {
    currentPres.data.slides.forEach(slide => {
      requests.push({ deleteObject: { objectId: slide.objectId } });
    });

    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests }
    });
  }

  // Create slides from template with ALL content
  const idMap = new Map(); // Map template IDs to new IDs

  for (let i = 0; i < templatePres.data.slides.length; i++) {
    const templateSlide = templatePres.data.slides[i];
    const slideRequests = [];

    // Generate valid ID (min 5 chars) for slide
    const newSlideId = `slide_${Date.now()}_${i}`;
    idMap.set(templateSlide.objectId, newSlideId);

    // Get actual layout from template (not 'BLANK')
    const layoutId = templateSlide.slideProperties?.layoutObjectId ||
                     templatePres.data.layouts?.[0]?.objectId;

    // Create slide with proper layout
    slideRequests.push({
      createSlide: {
        objectId: newSlideId,
        insertionIndex: i,
        slideLayoutReference: layoutId ? { layoutId } : { predefinedLayout: 'BLANK' }
      }
    });

    // Execute slide creation first
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: slideRequests }
    });

    // Now create all page elements
    const elementRequests = [];

    if (templateSlide.pageElements) {
      for (const element of templateSlide.pageElements) {
        const newElementId = `elem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        idMap.set(element.objectId, newElementId);

        if (element.shape) {
          // Create shape with basic properties
          elementRequests.push({
            createShape: {
              objectId: newElementId,
              shapeType: element.shape.shapeType || 'TEXT_BOX',
              elementProperties: {
                pageObjectId: newSlideId,
                size: element.size,
                transform: element.transform
              }
            }
          });

          // Add text with content
          if (element.shape.text) {
            const text = element.shape.text.textElements
              .map(te => te.textRun?.content || "")
              .join("");

            if (text) {
              elementRequests.push({
                insertText: {
                  objectId: newElementId,
                  text: text,
                  insertionIndex: 0
                }
              });
            }
          }
        }
        else if (element.image) {
          // Create image
          elementRequests.push({
            createImage: {
              objectId: newElementId,
              url: element.image.sourceUrl || element.image.contentUrl,
              elementProperties: {
                pageObjectId: newSlideId,
                size: element.size,
                transform: element.transform
              }
            }
          });
        }
        else if (element.video) {
          // Create video
          elementRequests.push({
            createVideo: {
              objectId: newElementId,
              source: element.video.source,
              id: element.video.id,
              elementProperties: {
                pageObjectId: newSlideId,
                size: element.size,
                transform: element.transform
              }
            }
          });
        }
        // Note: Tables, charts, and other complex elements may need special handling
      }
    }

    // Execute element creation
    if (elementRequests.length > 0) {
      await slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: elementRequests }
      });
    }
  }

  console.log("Presentation reset to template state.");
  return idMap; // Return mapping for edit application
}

// Apply edits to presentation using objectId matching
async function applyEditsToPresentation(slides, presentationId, editsData, idMap = null) {
  const presentation = await slides.presentations.get({ presentationId });
  const requests = [];

  // Map slideId -> slide for quick lookup
  const slideMap = new Map();
  presentation.data.slides.forEach(slide => {
    slideMap.set(slide.objectId, slide);
  });

  // Set of slide IDs to keep (map template IDs to actual IDs if needed)
  const keepSlideIds = new Set();
  editsData.forEach(edit => {
    const actualSlideId = idMap ? idMap.get(edit.slideId) : edit.slideId;
    if (actualSlideId) {
      keepSlideIds.add(actualSlideId);
    }
  });

  // Delete slides not in edit list
  presentation.data.slides.forEach(slide => {
    if (!keepSlideIds.has(slide.objectId)) {
      requests.push({ deleteObject: { objectId: slide.objectId } });
    }
  });

  // Apply edits to each slide
  for (const slideEdit of editsData) {
    // Map template ID to actual ID if mapping exists
    const actualSlideId = idMap ? idMap.get(slideEdit.slideId) : slideEdit.slideId;
    const slide = slideMap.get(actualSlideId);

    if (!slide) {
      console.warn(`Warning: Slide ${slideEdit.slideId} (${actualSlideId}) not found, skipping`);
      continue;
    }

    // Map objectId -> element for this slide
    const elementMap = new Map();
    if (slide.pageElements) {
      slide.pageElements.forEach(el => elementMap.set(el.objectId, el));
    }

    // Apply edits to each element
    for (const elementEdit of slideEdit.elements) {
      // Map template element ID to actual ID if mapping exists
      const actualElementId = idMap ? idMap.get(elementEdit.objectId) : elementEdit.objectId;

      if (!elementMap.has(actualElementId)) {
        console.warn(`Warning: Element ${elementEdit.objectId} (${actualElementId}) not found in slide ${slideEdit.slideId}, skipping`);
        continue;
      }

      // Clear existing text
      requests.push({
        deleteText: {
          objectId: actualElementId,
          textRange: { type: "ALL" }
        }
      });

      // Insert new text
      if (elementEdit.text) {
        requests.push({
          insertText: {
            objectId: actualElementId,
            text: elementEdit.text,
            insertionIndex: 0
          }
        });
      }
    }
  }

  // Execute all updates
  if (requests.length > 0) {
    await slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests }
    });
  }
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const editArgIndex = args.indexOf("--edit");
  const editFile = editArgIndex >= 0 ? args[editArgIndex + 1] : null;
  const fileArgIndex = args.indexOf("--file");
  const targetFileId = fileArgIndex >= 0 ? args[fileArgIndex + 1] : null;

  const auth = await authorize();
  const slides = google.slides({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  if (args.includes("--dump")) {
    console.log("Dumping template structure...");
    const dump = await dumpTemplate(slides, TEMPLATE_ID);
    fs.writeFileSync("template_dump.json", JSON.stringify(dump, null, 2));
    console.log("Template dumped to template_dump.json");
    console.log(`Format: Array of { slideId, elements: [{ objectId, text }] }`);
    process.exit(0);
  }

  if (!editFile) {
    console.error("Please provide --edit <file.json>");
    process.exit(1);
  }

  // Auto-dump template to ensure template_dump.json is up-to-date
  console.log("Refreshing template structure...");
  const templateDump = await dumpTemplate(slides, TEMPLATE_ID);
  fs.writeFileSync("template_dump.json", JSON.stringify(templateDump, null, 2));
  console.log("Template structure refreshed in template_dump.json");

  // Load and validate edits first
  console.log("Loading edits from file...");
  let edits;
  try {
    edits = JSON.parse(fs.readFileSync(editFile));
  } catch (error) {
    console.error("Error reading edit file:", error.message);
    process.exit(1);
  }

  if (!Array.isArray(edits)) {
    console.error("Error: Edit file must contain an array of slides");
    console.error("Expected format: [{ slideId, elements: [{ objectId, text }] }]");
    process.exit(1);
  }

let presentationId;
let oldPresentationId = null; // Track old ID for deletion

if (targetFileId) {
  // Check if edit file has new slide IDs
  console.log("Checking current presentation structure...");
  const currentDump = await dumpTemplate(slides, targetFileId);
  const currentSlideIds = new Set(currentDump.map(s => s.slideId));
  const hasNewSlides = edits.some(edit => !currentSlideIds.has(edit.slideId));

  if (hasNewSlides) {
    // Edit file references slides not in current presentation - copy template fresh
    console.log("Detected new slide IDs. Creating new presentation from template...");
    presentationId = await copyTemplate(drive, "AutoFilled Template");
    console.log("New presentation created:", presentationId);
    oldPresentationId = targetFileId; // Mark old one for deletion
  } else {
    // All slides exist - just update existing presentation
    console.log("All slides exist. Updating existing presentation...");
    presentationId = targetFileId;
  }
} else {
  // First time: create new presentation
  console.log("Creating new presentation from template...");
  presentationId = await copyTemplate(drive, "AutoFilled Template");
  console.log("Created presentation:", presentationId);
}

  // Apply edits
  console.log("Applying edits to presentation...");
  try {
    await applyEditsToPresentation(slides, presentationId, edits, null);
    console.log("Edits applied successfully!");
  } catch (error) {
    console.error("Error applying edits:", error.message);
    console.error("Presentation may be partially updated.");
    process.exit(1);
  }

  // Delete old presentation if we created a new one
  if (oldPresentationId) {
    console.log(`Deleting old presentation (${oldPresentationId})...`);
    try {
      await drive.files.delete({ fileId: oldPresentationId });
      console.log("Old presentation deleted.");
    } catch (error) {
      console.warn("Warning: Could not delete old presentation:", error.message);
    }
  }

  console.log("\nPresentation ready!");
  console.log("URL:", `https://docs.google.com/presentation/d/${presentationId}/edit`);
  console.log(`\nTo make further edits:`);
  console.log(`1. Edit ${editFile}`);
  console.log(`2. Run: node index.js --edit ${editFile} --file ${presentationId}`);
}

main().catch(console.error);

