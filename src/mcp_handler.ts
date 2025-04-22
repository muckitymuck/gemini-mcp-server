import playwright, { Page, Browser } from 'playwright';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GenerationConfig } from "@google/generative-ai";
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { saveScreenshotWithRecord, uploadScreenshot, getScreenshotUrl } from './supabase_handler';

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
async function saveScreenshot(
    screenshotBuffer: Buffer, 
    prompt: string, 
    url?: string, 
    tags?: string[],
    metadata?: Record<string, any>
): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptHash = Buffer.from(prompt).toString('base64').substring(0, 20);
    
    // Extract domain from URL if provided
    let domain = '';
    if (url) {
        try {
            const urlObj = new URL(url);
            domain = urlObj.hostname.replace(/[^a-zA-Z0-9]/g, '-');
            domain = `_${domain}`;
        } catch (error) {
            console.warn('Could not parse URL for domain extraction:', error);
        }
    }
    
    const filename = `screenshot_${timestamp}${domain}_${promptHash}.png`;

    try {
        // Try to upload to Supabase first
        // If URL is provided, try to use saveScreenshotWithRecord to save record with tags and metadata
        if (url) {
            try {
                const { publicUrl } = await saveScreenshotWithRecord(
                    screenshotBuffer,
                    url,
                    prompt,
                    tags,
                    metadata
                );
                console.log(`Screenshot saved to Supabase with metadata: ${publicUrl}`);
                return publicUrl;
            } catch (error) {
                console.warn('Failed to save screenshot with record, falling back to direct upload:', error);
            }
        }
        
        // Fallback to direct upload if not using record or if record save failed
        const storagePath = await uploadScreenshot(filename, screenshotBuffer);
        const publicUrl = await getScreenshotUrl(storagePath);
        console.log(`Screenshot uploaded to Supabase: ${publicUrl}`);
        return publicUrl;
    } catch (error) {
        console.warn('Failed to upload to Supabase, saving locally:', error);
        
        // Fall back to local storage
        const screenshotsDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
        }
        
        const filePath = path.join(screenshotsDir, filename);
        fs.writeFileSync(filePath, screenshotBuffer);
        console.log(`Screenshot saved locally to: ${filePath}`);
        return filePath;
    }
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
        navigationSteps?: Array<{
            type: 'click' | 'wait' | 'scroll' | 'search';
            selector?: string;
            duration?: number;
            value?: string;
            text?: string;
        }>;
    }
): Promise<{ browser: Browser; page: Page; screenshotBuffer: Buffer; axTree: object | null; navigationScreenshots: Array<{ url: string; path: string; publicUrl: string }> }> {
    let browser: Browser | null = null;
    const navigationScreenshots: Array<{ url: string; path: string; publicUrl: string }> = [];
    let lastUrl = '';

    try {
        browser = await playwright.chromium.launch({
            // headless: false, // Uncomment for debugging to see the browser
        });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
        });
        const page = await context.newPage();

        // Set default timeout for all operations
        page.setDefaultTimeout(30000);

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });
        console.log("Navigation complete.");

        // Handle initial popups and expand content
        try {
            // Handle cookie popup if present
            try {
                await page.waitForSelector('button:text("Accept all")', { timeout: 5000 });
                await page.click('button:text("Accept all")');
                console.log('Accepted cookies');
            } catch (error) {
                console.log('No cookie acceptance button found or already accepted');
            }

            // Handle localization popup if present
            try {
                await page.waitForSelector('button:text("Stay here")', { timeout: 5000 });
                await page.click('button:text("Stay here")');
                console.log('Clicked Stay here on localization popup');
            } catch (error) {
                console.log('No localization popup found');
            }

            // Click SEE ALL link if present
            try {
                await page.waitForSelector('a:text("SEE ALL")', { timeout: 5000 });
                await page.click('a:text("SEE ALL")');
                await page.waitForLoadState('networkidle');
                console.log('Expanded content by clicking SEE ALL');
            } catch (error) {
                console.log('No SEE ALL link found');
            }
        } catch (error) {
            console.warn('Error handling popups:', error);
        }

        // Take initial screenshot
        const initialScreenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
        const initialScreenshotPath = await saveScreenshot(
            initialScreenshotBuffer, 
            `Initial page load - ${url}`, 
            url,
            ['initial_load', 'page_entry'],
            { pageState: 'initial', pageTitle: await page.title() }
        );
        console.log(`Initial screenshot saved to: ${initialScreenshotPath}`);
        lastUrl = url;

        // Handle navigation steps if specified
        if (navigationOptions?.navigationSteps) {
            for (const step of navigationOptions.navigationSteps) {
                console.log(`Executing navigation step: ${JSON.stringify(step)}`);
                try {
                    switch (step.type) {
                        case 'click':
                            if (step.text) {
                                // Use text-based selector
                                await page.getByText(step.text, { exact: false }).click({
                                    timeout: 5000,
                                    force: true
                                });
                            } else if (step.selector) {
                                await page.waitForSelector(step.selector, { 
                                    state: 'visible',
                                    timeout: 10000 
                                });
                                await page.click(step.selector, {
                                    timeout: 5000,
                                    force: true
                                });
                            }
                            await page.waitForLoadState('networkidle', { timeout: 10000 });
                            break;
                        case 'wait':
                            if (step.duration) {
                                await page.waitForTimeout(step.duration);
                            }
                            break;
                        case 'scroll':
                            if (step.selector) {
                                try {
                                    await page.waitForSelector(step.selector, { 
                                        state: 'visible',
                                        timeout: 5000 
                                    });
                                    await page.evaluate((selector) => {
                                        const element = document.querySelector(selector);
                                        if (element) {
                                            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        }
                                    }, step.selector);
                                } catch (error) {
                                    console.warn(`Could not find selector ${step.selector} for scrolling, trying to scroll page`);
                                    await page.evaluate(() => {
                                        window.scrollTo(0, document.body.scrollHeight);
                                    });
                                }
                                await page.waitForTimeout(1000);
                            }
                            break;
                        case 'search':
                            if (step.selector && step.value) {
                                try {
                                    // First try to find and click the search button
                                    const searchButtonSelectors = [
                                        'button[aria-label*="search"]',
                                        'button[aria-label*="Search"]',
                                        'svg[alt="search"]',
                                        'svg[alt="Search"]',
                                        'button svg[alt="search"]',
                                        'button svg[alt="Search"]'
                                    ];
                                    
                                    let searchButtonFound = false;
                                    for (const buttonSelector of searchButtonSelectors) {
                                        try {
                                            await page.waitForSelector(buttonSelector, { 
                                                state: 'visible',
                                                timeout: 5000 
                                            });
                                            await page.click(buttonSelector);
                                            await page.waitForTimeout(1000); // Wait for search input to appear
                                            searchButtonFound = true;
                                            console.log(`Found and clicked search button using selector: ${buttonSelector}`);
                                            break;
                                        } catch (error) {
                                            console.log(`Search button selector ${buttonSelector} not found, trying next...`);
                                        }
                                    }
                                    
                                    if (!searchButtonFound) {
                                        console.warn('Could not find search button on the page');
                                        break;
                                    }

                                    // Now try to find the search input
                                    const searchInputSelectors = [
                                        'input[type="search"]',
                                        'input[name="search"]',
                                        'input#search',
                                        'input[aria-label*="Search"]',
                                        'input[aria-label*="search"]'
                                    ];
                                    
                                    let searchInputFound = false;
                                    for (const searchSelector of searchInputSelectors) {
                                        try {
                                            await page.waitForSelector(searchSelector, { 
                                                state: 'visible',
                                                timeout: 5000 
                                            });
                                            await page.fill(searchSelector, step.value);
                                            await page.keyboard.press('Enter');
                                            await page.waitForLoadState('networkidle', { timeout: 10000 });
                                            searchInputFound = true;
                                            console.log(`Found search input using selector: ${searchSelector}`);
                                            break;
                                        } catch (error) {
                                            console.log(`Search input selector ${searchSelector} not found, trying next...`);
                                        }
                                    }
                                    
                                    if (!searchInputFound) {
                                        console.warn('Could not find search input after clicking search button');
                                    }
                                } catch (error) {
                                    console.warn(`Failed to perform search: ${error}`);
                                }
                            }
                            break;
                    }
                    console.log(`Successfully executed step: ${step.type}`);

                    // Check if URL has changed after navigation
                    const currentUrl = page.url();
                    if (currentUrl !== lastUrl) {
                        console.log(`URL changed to: ${currentUrl}`);
                        const stepScreenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
                        const stepScreenshotPath = await saveScreenshot(
                            stepScreenshotBuffer, 
                            `Navigation - ${currentUrl}`, 
                            currentUrl,
                            ['navigation_step', 'interaction'],
                            { 
                                stepType: step.type, 
                                stepDetails: JSON.stringify(step),
                                pageTitle: await page.title() 
                            }
                        );
                        console.log(`Navigation screenshot saved to: ${stepScreenshotPath}`);
                        lastUrl = currentUrl;
                    }

                } catch (error) {
                    console.warn(`Failed to execute step ${step.type}:`, error);
                }
            }
        }

        // Handle additional navigation options
        if (navigationOptions) {
            // Click elements if specified
            if (navigationOptions.clickSelectors) {
                for (const selector of navigationOptions.clickSelectors) {
                    console.log(`Attempting to click element: ${selector}`);
                    try {
                        // First wait for the element to be visible and clickable
                        await page.waitForSelector(selector, { 
                            state: 'visible',
                            timeout: 10000 // 10 seconds for element to appear
                        });
                        
                        // Then try to click it
                        await page.click(selector, {
                            timeout: 5000, // 5 seconds for click to complete
                            force: true // Force click even if element is hidden
                        });
                        
                        // Wait for any network activity to settle
                        await page.waitForLoadState('networkidle', { timeout: 10000 });
                        console.log(`Successfully clicked element: ${selector}`);
                    } catch (error) {
                        console.warn(`Failed to click element ${selector}:`, error);
                        // Continue with other actions even if one click fails
                    }
                }
            }

            // Fill form inputs if specified
            if (navigationOptions.formInputs) {
                for (const input of navigationOptions.formInputs) {
                    console.log(`Attempting to fill form input: ${input.selector}`);
                    try {
                        await page.waitForSelector(input.selector, { 
                            state: 'visible',
                            timeout: 10000 
                        });
                        await page.fill(input.selector, input.value);
                        console.log(`Successfully filled input: ${input.selector}`);
                    } catch (error) {
                        console.warn(`Failed to fill input ${input.selector}:`, error);
                    }
                }
            }

            // Scroll to bottom if requested
            if (navigationOptions.scrollToBottom) {
                console.log("Scrolling to bottom of page...");
                try {
                    await page.evaluate(() => {
                        window.scrollTo(0, document.body.scrollHeight);
                    });
                    await page.waitForTimeout(2000); // Wait for any lazy-loaded content
                    console.log("Successfully scrolled to bottom");
                } catch (error) {
                    console.warn("Failed to scroll to bottom:", error);
                }
            }

            // Wait for specific elements if specified
            if (navigationOptions.waitForSelectors) {
                for (const selector of navigationOptions.waitForSelectors) {
                    console.log(`Waiting for element: ${selector}`);
                    try {
                        await page.waitForSelector(selector, { 
                            state: 'visible',
                            timeout: 10000 
                        });
                        console.log(`Element appeared: ${selector}`);
                    } catch (error) {
                        console.warn(`Element did not appear: ${selector}`, error);
                    }
                }
            }

            // Follow links if specified
            if (navigationOptions.followLinks) {
                for (const linkSelector of navigationOptions.followLinks) {
                    console.log(`Attempting to follow link: ${linkSelector}`);
                    try {
                        await page.waitForSelector(linkSelector, { 
                            state: 'visible',
                            timeout: 10000 
                        });
                        await page.click(linkSelector, {
                            timeout: 5000,
                            force: true
                        });
                        await page.waitForLoadState('networkidle', { timeout: 10000 });
                        console.log(`Successfully followed link: ${linkSelector}`);
                    } catch (error) {
                        console.warn(`Failed to follow link ${linkSelector}:`, error);
                    }
                }
            }
        }

        // Take final screenshot if URL has changed
        const finalUrl = page.url();
        if (finalUrl !== lastUrl) {
            const finalScreenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
            const finalScreenshotPath = await saveScreenshot(
                finalScreenshotBuffer, 
                `Final page - ${finalUrl}`, 
                finalUrl,
                ['final_state', 'page_result'],
                { pageState: 'final', pageTitle: await page.title() }
            );
            console.log(`Final screenshot saved to: ${finalScreenshotPath}`);
        }

        console.log("Capturing accessibility tree...");
        const axTree = await page.accessibility.snapshot();
        console.log("Accessibility tree captured.");

        return { browser, page, screenshotBuffer: await page.screenshot({ fullPage: true, type: 'png' }), axTree, navigationScreenshots };

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

// --- Helper Function: Analyze Navigation Needs ---
async function analyzeNavigationNeeds(prompt: string): Promise<{
    clickSelectors?: string[];
    formInputs?: Array<{ selector: string; value: string }>;
    scrollToBottom?: boolean;
    waitForSelectors?: string[];
    followLinks?: string[];
    navigationSteps?: Array<{
        type: 'click' | 'wait' | 'scroll' | 'search';
        selector?: string;
        duration?: number;
        value?: string;
        text?: string;
    }>;
}> {
    const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL_NAME,
        generationConfig: {
            temperature: 0.2,
            topK: 1,
            topP: 1,
            maxOutputTokens: 1000,
        },
    });

    const analysisPrompt = `Analyze the following user prompt and determine what navigation actions are needed to find and gather information about laptops on a webpage. 
Return a JSON object with navigation steps that will:
1. First try to find laptops through main navigation (products/shop menus)
2. If not found, try searching for laptops
3. Ensure proper waiting between actions for pages to load
4. Include scrolling to find all products

The navigationSteps array should contain a sequence of actions like:
- { type: 'click', text: 'Products' } - Click elements by their visible text
- { type: 'wait', duration: milliseconds } - Wait for content to load
- { type: 'scroll', selector: 'section-selector' } - Scroll to specific sections
- { type: 'search', selector: 'input[type="search"]', value: 'laptops' } - Perform search

For ROG website specifically, use these selectors:
- Products menu: text="Products" or text="Shop"
- Laptops link: text="Laptops" or text="Gaming Laptops"
- Product grid: .product-list or .product-container
- Search input: input[type="search"] or .search-input

Example response format:
{
  "navigationSteps": [
    { "type": "click", "text": "Products" },
    { "type": "wait", "duration": 2000 },
    { "type": "click", "text": "Laptops" },
    { "type": "wait", "duration": 3000 },
    { "type": "scroll", "selector": ".product-list" },
    { "type": "wait", "duration": 2000 }
  ]
}

User Prompt: "${prompt}"

Return ONLY the JSON object with navigation steps, nothing else. Do not include any markdown formatting or code blocks.`;

    try {
        const result = await model.generateContent(analysisPrompt);
        if (!result.response) {
            throw new Error("Gemini API returned an empty response.");
        }

        const responseText = result.response.text();
        
        // Clean the response text to ensure it's valid JSON
        let cleanResponse = responseText.trim();
        cleanResponse = cleanResponse.replace(/```json\n?|\n?```/g, '');
        cleanResponse = cleanResponse.trim();
        
        if (!cleanResponse) {
            return {};
        }

        const navigationOptions = JSON.parse(cleanResponse);
        
        // Validate the structure of the returned options
        if (typeof navigationOptions !== 'object') {
            return {};
        }

        return {
            clickSelectors: Array.isArray(navigationOptions.clickSelectors) ? navigationOptions.clickSelectors : undefined,
            formInputs: Array.isArray(navigationOptions.formInputs) ? navigationOptions.formInputs : undefined,
            scrollToBottom: typeof navigationOptions.scrollToBottom === 'boolean' ? navigationOptions.scrollToBottom : undefined,
            waitForSelectors: Array.isArray(navigationOptions.waitForSelectors) ? navigationOptions.waitForSelectors : undefined,
            followLinks: Array.isArray(navigationOptions.followLinks) ? navigationOptions.followLinks : undefined,
            navigationSteps: Array.isArray(navigationOptions.navigationSteps) ? navigationOptions.navigationSteps : undefined,
        };
    } catch (error) {
        console.error("Error analyzing navigation needs:", error);
        return {};
    }
}

// --- Main Handler Function ---
export async function handleMcpRequest(url: string, userPrompt: string): Promise<string> {
    let browser: Browser | null = null;

    try {
        // Analyze the prompt to determine navigation needs
        const navigationOptions = await analyzeNavigationNeeds(userPrompt);
        console.log("Determined navigation options:", navigationOptions);

        // 1. Use Playwright to get page content with determined navigation options
        const {
            browser: pageBrowser,
            page,
            screenshotBuffer,
            axTree,
            navigationScreenshots
        } = await getPageContent(url, navigationOptions);
        browser = pageBrowser;

        // Log all captured screenshots
        console.log("Navigation screenshots captured:");
        navigationScreenshots.forEach((screenshot, index) => {
            console.log(`Step ${index + 1}: ${screenshot.url}`);
            console.log(`  Screenshot URL: ${screenshot.publicUrl}`);
        });

        // Convert final screenshot to base64 for Gemini
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