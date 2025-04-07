import playwright, { Page, Browser } from 'playwright';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig } from "@google/generative-ai";
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';

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

// --- Helper Function: Save Screenshot ---
async function saveScreenshot(screenshotBuffer: Buffer, prompt: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptHash = Buffer.from(prompt).toString('base64').substring(0, 20);
    const filename = `screenshot_${timestamp}_${promptHash}.png`;
    const screenshotsDir = path.join(process.cwd(), 'screenshots');
    
    // Create screenshots directory if it doesn't exist
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    
    const filePath = path.join(screenshotsDir, filename);
    fs.writeFileSync(filePath, screenshotBuffer);
    console.log(`Screenshot saved to: ${filePath}`);
    return filePath;
}

// --- Helper Function: Get Page Content ---
async function getPageContent(
    url: string,
    navigationOptions?: {
        clickSelectors?: string[];
        formInputs?: Array<{ selector: string; value: string }>;
        scrollToBottom?: boolean;
        waitForSelectors?: string[];
        followLinks?: string[];
    }
): Promise<{ browser: Browser; page: Page; screenshotBuffer: Buffer; axTree: object | null }> {
    let browser: Browser | null = null;
    try {
        browser = await playwright.chromium.launch({
            // headless: false, // Uncomment for debugging to see the browser
        });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
        });
        const page = await context.newPage();

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        console.log("Navigation complete.");

        // Handle additional navigation options
        if (navigationOptions) {
            // Click elements if specified
            if (navigationOptions.clickSelectors) {
                for (const selector of navigationOptions.clickSelectors) {
                    console.log(`Clicking element: ${selector}`);
                    await page.click(selector);
                    await page.waitForLoadState('networkidle');
                }
            }

            // Fill form inputs if specified
            if (navigationOptions.formInputs) {
                for (const input of navigationOptions.formInputs) {
                    console.log(`Filling form input: ${input.selector}`);
                    await page.fill(input.selector, input.value);
                }
            }

            // Scroll to bottom if requested
            if (navigationOptions.scrollToBottom) {
                console.log("Scrolling to bottom of page...");
                await page.evaluate(() => {
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(1000); // Wait for any lazy-loaded content
            }

            // Wait for specific elements if specified
            if (navigationOptions.waitForSelectors) {
                for (const selector of navigationOptions.waitForSelectors) {
                    console.log(`Waiting for element: ${selector}`);
                    await page.waitForSelector(selector, { timeout: 10000 });
                }
            }

            // Follow links if specified
            if (navigationOptions.followLinks) {
                for (const linkSelector of navigationOptions.followLinks) {
                    console.log(`Following link: ${linkSelector}`);
                    await page.click(linkSelector);
                    await page.waitForLoadState('networkidle');
                }
            }
        }

        console.log("Taking screenshot...");
        const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
        console.log("Screenshot captured.");

        console.log("Capturing accessibility tree...");
        const axTree = await page.accessibility.snapshot();
        console.log("Accessibility tree captured.");

        return { browser, page, screenshotBuffer, axTree };

    } catch (error) {
        console.error("Error during Playwright operation:", error);
        if (browser) {
            await browser.close();
        }
        if (error instanceof playwright.errors.TimeoutError) {
            throw new Error(`Timeout navigating to or processing ${url}. The page might be too slow or unresponsive.`);
        }
        throw new Error(`Failed to get page content for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// --- Main Handler Function ---
export async function handleMcpRequest(
    url: string, 
    userPrompt: string,
    navigationOptions?: {
        clickSelectors?: string[];
        formInputs?: Array<{ selector: string; value: string }>;
        scrollToBottom?: boolean;
        waitForSelectors?: string[];
        followLinks?: string[];
    }
): Promise<string> {
    let browser: Browser | null = null;

    try {
        // 1. Use Playwright to get page content with navigation options
        const {
            browser: pageBrowser,
            page,
            screenshotBuffer,
            axTree
        } = await getPageContent(url, navigationOptions);
        browser = pageBrowser;

        // Save the screenshot with prompt information
        await saveScreenshot(screenshotBuffer, userPrompt);

        // Convert screenshot to base64 for Gemini
        const screenshotBase64 = screenshotBuffer.toString('base64');

        if (!axTree) {
            console.warn("Accessibility tree could not be captured.");
        }

        // 2. Prepare the prompt for Gemini Vision model
        const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL_NAME,
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