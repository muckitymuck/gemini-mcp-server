import playwright, { Page, Browser } from 'playwright';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig } from "@google/generative-ai";
import fs from 'fs'; // Used temporarily if saving screenshots locally for debugging
import dotenv from 'dotenv';

dotenv.config();

// --- Configuration ---
// Consider using a newer model if available and suitable (e.g., gemini-1.5-pro-latest)
// gemini-pro-vision is older but stable for vision tasks.
// gemini-1.5-flash-latest is a good balance of speed and capability.
const GEMINI_MODEL_NAME = "gemini-1.5-flash-latest";
const API_KEY = process.env.GEMINI_API_KEY || "";

if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

// Optional: Configure safety settings
// const safetySettings = [
//     { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
//     { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
//     { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
//     { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
// ];


// Optional: Configure generation settings
const generationConfig: GenerationConfig = {
    temperature: 0.4, // Adjust creativity/determinism
    topK: 32,
    topP: 1,
    maxOutputTokens: 4096, // Adjust based on expected response size
};

// --- Helper Function: Get Page Content ---
async function getPageContent(url: string): Promise<{ browser: Browser; page: Page; screenshotBase64: string; axTree: object | null }> {
    let browser: Browser | null = null;
    try {
        browser = await playwright.chromium.launch({
            // headless: false, // Uncomment for debugging to see the browser
        });
        const context = await browser.newContext({
            // Set viewport for consistent screenshots
             viewport: { width: 1280, height: 720 }, // Example viewport
             // Consider deviceScaleFactor if needed
        });
        const page = await context.newPage();

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); // Wait until network is idle, increased timeout
        console.log("Navigation complete.");

        console.log("Taking screenshot...");
        // Capture full page screenshot as buffer, then convert to base64
        const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
        const screenshotBase64 = screenshotBuffer.toString('base64');
        console.log("Screenshot captured.");

        // --- Optional: Save screenshot locally for debugging ---
        // try {
        //     fs.writeFileSync('debug_screenshot.png', screenshotBuffer);
        //     console.log("Debug screenshot saved to debug_screenshot.png");
        // } catch (err) {
        //     console.error("Failed to save debug screenshot:", err);
        // }
        // --- End Optional Debug Save ---


        console.log("Capturing accessibility tree...");
        // Capture the accessibility tree
        // Note: The AX tree can be VERY large.
        const axTree = await page.accessibility.snapshot({
             // interestingOnly: false, // Set to true to potentially reduce size, but might miss context
             // root: await page.locator('body').elementHandle() ?? undefined // Limit to body to reduce size? Test needed.
        });
        console.log("Accessibility tree captured.");

         // --- Optional: Save AX Tree locally for debugging ---
        // try {
        //     fs.writeFileSync('debug_axtree.json', JSON.stringify(axTree, null, 2));
        //     console.log("Debug AX tree saved to debug_axtree.json");
        // } catch (err) {
        //     console.error("Failed to save debug AX tree:", err);
        // }
        // --- End Optional Debug Save ---


        // Return browser and page along with content so they can be closed later
        return { browser, page, screenshotBase64, axTree };

    } catch (error) {
        console.error("Error during Playwright operation:", error);
        if (browser) {
            await browser.close(); // Attempt cleanup on error
        }
        // Re-throw a more specific error
         if (error instanceof playwright.errors.TimeoutError) {
             throw new Error(`Timeout navigating to or processing ${url}. The page might be too slow or unresponsive.`);
         }
        throw new Error(`Failed to get page content for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// --- Main Handler Function ---
export async function handleMcpRequest(url: string, userPrompt: string): Promise<string> {
    let browser: Browser | null = null;

    try {
        // 1. Use Playwright to get page content
        const {
            browser: pageBrowser, // Renamed to avoid conflict
            page,
            screenshotBase64,
            axTree
        } = await getPageContent(url);
        browser = pageBrowser; // Assign to outer scope variable for finally block

        if (!axTree) {
             console.warn("Accessibility tree could not be captured.");
             // Decide if you want to proceed without it or throw an error
             // throw new Error("Failed to capture accessibility tree.");
        }

        // 2. Prepare the prompt for Gemini Vision model
        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL_NAME,
            // safetySettings,
            generationConfig,
        });

        const promptParts = [
            { text: `You are an assistant analyzing a webpage using its screenshot and accessibility tree (AX Tree). The user wants you to perform the following task:\n\nUser Prompt: "${userPrompt}"\n\nAnalyze the provided screenshot and the structure described by the AX Tree to fulfill the user's request. Provide a clear and concise response.` },
            {
                inlineData: {
                    mimeType: "image/png",
                    data: screenshotBase64,
                },
            },
            // Conditionally add AX tree if captured
            ...(axTree ? [
                { text: "\n\nAccessibility Tree (AX Tree) Structure:\n```json\n" + JSON.stringify(axTree, null, 2) + "\n```" }
                // Note: Sending the full JSON AX tree might exceed token limits for complex pages.
                // Consider summarizing or extracting key parts if needed, but start with the full tree.
            ] : [
                { text: "\n\n(Accessibility tree was not available for analysis)"}
            ]),
        ];

        console.log(`Sending prompt parts to Gemini (${GEMINI_MODEL_NAME})...`);
        // console.log("Prompt Text (excluding image/AX tree data):", promptParts.filter(p => 'text' in p).map(p => (p as {text: string}).text).join('')); // Log text parts for debugging

        // 3. Call Gemini API
        const result = await model.generateContent({ contents: [{ role: "user", parts: promptParts }] });

        console.log("Received response from Gemini.");

        if (!result.response) {
             throw new Error("Gemini API returned an empty response.");
        }

        // Check for blocked content
        if (result.response.promptFeedback?.blockReason) {
            console.error("Gemini response blocked:", result.response.promptFeedback.blockReason);
             throw new Error(`Request blocked by Gemini due to ${result.response.promptFeedback.blockReason}.`);
        }

        const responseText = result.response.text(); // Use .text() method

        if (!responseText) {
            console.warn("Gemini response text is empty. Full response:", JSON.stringify(result.response, null, 2));
            return "(Gemini returned an empty response)";
        }

        return responseText;

    } catch (error) {
        console.error("Error in handleMcpRequest:", error);
        // Ensure the error message is useful
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`MCP processing failed: ${errorMessage}`); // Re-throw standardized error
    } finally {
        // 4. Clean up Playwright resources
        if (browser) {
            try {
                await browser.close();
                console.log("Playwright browser closed.");
            } catch (closeError) {
                console.error("Error closing Playwright browser:", closeError);
            }
        }
    }
}