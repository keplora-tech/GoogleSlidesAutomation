#!/usr/bin/env node
import fs from "fs";
import readline from "readline";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

if (!GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY environment variable not set");
  console.error("Set it with: export GEMINI_API_KEY='your-api-key'");
  process.exit(1);
}

// Call Gemini API with retry logic for rate limits
async function callGemini(prompt, retries = 3, delay = 2000) {
  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    }
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (response.status === 429) {
        // Rate limit - wait and retry
        const waitTime = delay * Math.pow(2, attempt);
        console.log(`Rate limit hit. Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error("No response from Gemini");
      }

      return text;
    } catch (error) {
      if (attempt === retries - 1) throw error;
      console.log(`Error: ${error.message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Extract JSON from response (handles markdown code blocks)
function extractJSON(text) {
  // Try to find JSON in code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON array
  const jsonMatch = text.match(/\[\s*{[\s\S]*}\s*\]/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text.trim();
}

// Interactive AI editing mode
async function aiEditMode(templateFile, editFile) {
  console.log("\n=== AI Edit Mode ===");
  console.log("Loading files...");

  // Read template and current edits
  let template, currentEdits;
  try {
    template = JSON.parse(fs.readFileSync(templateFile, 'utf-8'));
    currentEdits = JSON.parse(fs.readFileSync(editFile, 'utf-8'));
  } catch (error) {
    console.error("Error reading files:", error.message);
    process.exit(1);
  }

  console.log(`Template: ${template.length} slides`);
  console.log(`Current edits: ${currentEdits.length} slides`);
  console.log("\nCommands:");
  console.log("  - 'slide N <request>': Edit specific slide (e.g., 'slide 2 make it more engaging')");
  console.log("  - '<request>': Edit all slides");
  console.log("  - 'save': Save changes to file");
  console.log("  - 'quit': Exit without saving");
  console.log("  - 'show': Show current JSON structure");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> '
  });

  let workingJSON = currentEdits;
  let hasUnsavedChanges = false;

  const systemPrompt = `You are a presentation editor. You receive a template structure and current presentation content in JSON format.

Template format: Array of slides with slideId and elements (objectId + text)
Current content: Same format, what the user is currently editing

Your job: Modify the current content based on user requests and return ONLY the updated JSON array.

Rules:
- Keep the same slideId and objectId from template/current content
- Only modify the "text" field of elements
- If user asks to add slides, copy structure from template
- If user asks to remove slides, remove from array
- Return ONLY valid JSON array, nothing else
- Do not include explanations, just the JSON

Example request: "Make slide 2 more engaging"
Example response: [{"slideId":"p","elements":[...]}, {"slideId":"g123","elements":[{"objectId":"i0","text":"Exciting New Content!\\n"},...]}]`;

  rl.prompt();

  rl.on('line', async (input) => {
    const command = input.trim().toLowerCase();

    if (command === 'quit' || command === 'exit') {
      if (hasUnsavedChanges) {
        console.log("Warning: You have unsaved changes!");
        rl.question("Really quit? (yes/no): ", (answer) => {
          if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
            rl.close();
          } else {
            rl.prompt();
          }
        });
      } else {
        rl.close();
      }
      return;
    }

    if (command === 'save') {
      try {
        fs.writeFileSync(editFile, JSON.stringify(workingJSON, null, 2));
        console.log(`✓ Saved to ${editFile}`);
        hasUnsavedChanges = false;
      } catch (error) {
        console.error("Error saving file:", error.message);
      }
      rl.prompt();
      return;
    }

    if (command === 'show') {
      console.log("\nCurrent structure:");
      workingJSON.forEach((slide, i) => {
        const firstText = slide.elements?.[0]?.text?.substring(0, 50) || "(empty)";
        console.log(`  Slide ${i + 1} (${slide.slideId}): ${firstText}...`);
      });
      rl.prompt();
      return;
    }

    if (!input.trim()) {
      rl.prompt();
      return;
    }

    // Check if editing specific slide
    const slideMatch = input.match(/^slide\s+(\d+)\s+(.+)$/i);
    const targetSlideIndex = slideMatch ? parseInt(slideMatch[1]) - 1 : null;
    const actualRequest = slideMatch ? slideMatch[2] : input;

    if (targetSlideIndex !== null && (targetSlideIndex < 0 || targetSlideIndex >= workingJSON.length)) {
      console.error(`❌ Invalid slide number. Valid range: 1-${workingJSON.length}`);
      rl.prompt();
      return;
    }

    // AI processing
    console.log(`🤖 Processing with AI... ${targetSlideIndex !== null ? `(slide ${targetSlideIndex + 1})` : '(all slides)'}`);

    try {
      let currentPrompt;
      let newJSON = null;
      let attempts = 0;
      const maxAttempts = 10;

      if (targetSlideIndex !== null) {
        // Edit single slide
        const targetSlide = workingJSON[targetSlideIndex];
        const templateSlide = template[targetSlideIndex] || template[0];

        currentPrompt = `You are editing a single slide in a presentation.

TEMPLATE SLIDE STRUCTURE:
${JSON.stringify(templateSlide, null, 2)}

CURRENT SLIDE CONTENT:
${JSON.stringify(targetSlide, null, 2)}

USER REQUEST: ${actualRequest}

Return ONLY the updated slide as a JSON object (not an array). Keep the same slideId and element objectIds:`;

        while (attempts < maxAttempts && !newJSON) {
          const response = await callGemini(currentPrompt);
          const jsonText = extractJSON(response);

          try {
            const updatedSlide = JSON.parse(jsonText);

            // Validate structure
            if (!updatedSlide.slideId) {
              throw new Error("Slide missing slideId");
            }
            if (!Array.isArray(updatedSlide.elements)) {
              throw new Error("Slide missing elements array");
            }

            // Update working JSON
            newJSON = [...workingJSON];
            newJSON[targetSlideIndex] = updatedSlide;
            break;

          } catch (parseError) {
            attempts++;
            if (attempts >= maxAttempts) {
              throw new Error(`JSON validation failed after ${maxAttempts} attempts: ${parseError.message}`);
            }

            console.log(`⚠ Validation error (attempt ${attempts}/${maxAttempts}): ${parseError.message}`);
            console.log("🤖 Asking AI to fix...");

            currentPrompt = `The following JSON has a validation error: ${parseError.message}

BROKEN JSON:
${jsonText}

Fix ONLY the JSON syntax and structure errors. Return the corrected slide object:`;
          }
        }
      } else {
        // Edit all slides
        currentPrompt = `${systemPrompt}

TEMPLATE STRUCTURE:
${JSON.stringify(template, null, 2)}

CURRENT CONTENT:
${JSON.stringify(workingJSON, null, 2)}

USER REQUEST: ${actualRequest}

Return ONLY the updated JSON array. Ensure valid JSON syntax:`;

        while (attempts < maxAttempts && !newJSON) {
          const response = await callGemini(currentPrompt);
          const jsonText = extractJSON(response);

          try {
            newJSON = JSON.parse(jsonText);

            // Validate structure
            if (!Array.isArray(newJSON)) {
              throw new Error("Response is not a valid array");
            }

            for (let i = 0; i < newJSON.length; i++) {
              if (!newJSON[i].slideId) {
                throw new Error(`Slide ${i} missing slideId`);
              }
              if (!Array.isArray(newJSON[i].elements)) {
                throw new Error(`Slide ${i} missing elements array`);
              }
            }
            break;

          } catch (parseError) {
            attempts++;
            if (attempts >= maxAttempts) {
              throw new Error(`JSON validation failed after ${maxAttempts} attempts: ${parseError.message}`);
            }

            console.log(`⚠ Validation error (attempt ${attempts}/${maxAttempts}): ${parseError.message}`);
            console.log("🤖 Asking AI to fix...");

            currentPrompt = `The following JSON has a validation error: ${parseError.message}

BROKEN JSON:
${jsonText}

Fix ONLY the JSON syntax and structure errors. Return the corrected valid JSON array:`;
          }
        }
      }

      if (!newJSON) {
        throw new Error("Failed to get valid JSON from AI");
      }

      workingJSON = newJSON;
      hasUnsavedChanges = true;

      console.log("✓ Updated!");
      if (targetSlideIndex !== null) {
        console.log(`\nSlide ${targetSlideIndex + 1} preview:`);
        const firstText = workingJSON[targetSlideIndex].elements?.[0]?.text?.substring(0, 80) || "(empty)";
        console.log(`  ${firstText}...`);
      } else {
        console.log("\nPreview:");
        workingJSON.forEach((slide, i) => {
          const firstText = slide.elements?.[0]?.text?.substring(0, 60) || "(empty)";
          console.log(`  Slide ${i + 1}: ${firstText}...`);
        });
      }

    } catch (error) {
      console.error("❌ Error:", error.message);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    if (hasUnsavedChanges) {
      console.log("\n⚠ Exited with unsaved changes");
    } else {
      console.log("\nGoodbye!");
    }
    process.exit(0);
  });
}

// CLI entry point
const args = process.argv.slice(2);
const templateFile = args[0] || 'template_dump.json';
const editFile = args[1] || 'new.json';

if (!fs.existsSync(templateFile)) {
  console.error(`Error: Template file not found: ${templateFile}`);
  console.error("\nUsage: node ai-edit.js [template_file] [edit_file]");
  console.error("Example: node ai-edit.js template_dump.json new.json");
  process.exit(1);
}

if (!fs.existsSync(editFile)) {
  console.error(`Error: Edit file not found: ${editFile}`);
  console.error(`Creating empty edit file from template...`);
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf-8'));
  fs.writeFileSync(editFile, JSON.stringify(template, null, 2));
  console.log(`Created ${editFile}`);
}

aiEditMode(templateFile, editFile).catch(console.error);
