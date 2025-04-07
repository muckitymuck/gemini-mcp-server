import express, { Request, Response, RequestHandler } from 'express';
import dotenv from 'dotenv';
import { handleMcpRequest } from './mcp_handler'; // Import the handler

console.log('Starting server initialization...');
console.log('Current working directory:', process.cwd());
console.log('Loading .env file...');

// Load environment variables from .env file
const result = dotenv.config();
console.log('dotenv config result:', result);

console.log('Environment variables loaded:', {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'Present' : 'Missing',
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV
});

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON request bodies
app.use(express.json({ limit: '10mb' })); // Increase limit if AX tree/screenshots are large

// --- API Endpoint ---
app.post('/process', (async (req: Request, res: Response) => {
    const { url, prompt, navigationOptions } = req.body;

    // Basic Input Validation
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "url" in request body.' });
    }
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "prompt" in request body.' });
    }

    // Validate URL format (basic)
    try {
        new URL(url);
    } catch (_) {
        return res.status(400).json({ error: 'Invalid URL format provided.' });
    }

    // Validate navigation options if provided
    if (navigationOptions) {
        if (typeof navigationOptions !== 'object') {
            return res.status(400).json({ error: 'Invalid navigation options format.' });
        }

        // Validate clickSelectors
        if (navigationOptions.clickSelectors && 
            (!Array.isArray(navigationOptions.clickSelectors) || 
             !navigationOptions.clickSelectors.every((s: string) => typeof s === 'string'))) {
            return res.status(400).json({ error: 'Invalid clickSelectors format.' });
        }

        // Validate formInputs
        if (navigationOptions.formInputs && 
            (!Array.isArray(navigationOptions.formInputs) || 
             !navigationOptions.formInputs.every((input: { selector: string; value: string }) => 
                typeof input === 'object' && 
                typeof input.selector === 'string' && 
                typeof input.value === 'string'))) {
            return res.status(400).json({ error: 'Invalid formInputs format.' });
        }

        // Validate waitForSelectors
        if (navigationOptions.waitForSelectors && 
            (!Array.isArray(navigationOptions.waitForSelectors) || 
             !navigationOptions.waitForSelectors.every((s: string) => typeof s === 'string'))) {
            return res.status(400).json({ error: 'Invalid waitForSelectors format.' });
        }

        // Validate followLinks
        if (navigationOptions.followLinks && 
            (!Array.isArray(navigationOptions.followLinks) || 
             !navigationOptions.followLinks.every((s: string) => typeof s === 'string'))) {
            return res.status(400).json({ error: 'Invalid followLinks format.' });
        }
    }

    console.log(`Received request: URL=${url}, Prompt="${prompt}", NavigationOptions=${JSON.stringify(navigationOptions)}`);

    try {
        const startTime = Date.now();
        const geminiResponse = await handleMcpRequest(url, prompt, navigationOptions);
        const duration = (Date.now() - startTime) / 1000;

        console.log(`Successfully processed request in ${duration.toFixed(2)} seconds.`);
        res.status(200).json({ response: geminiResponse });

    } catch (error) {
        console.error("API Error:", error);
        const message = error instanceof Error ? error.message : "An unknown error occurred during processing.";
        let statusCode = 500;
        if (message.includes("Timeout navigating") || message.includes("Failed to get page content")) {
            statusCode = 400;
        } else if (message.includes("blocked by Gemini")) {
            statusCode = 400;
        }
        res.status(statusCode).json({ error: message });
    }
}) as RequestHandler);

// --- Health Check Endpoint (Optional) ---
 app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
 });


// --- Start Server ---
app.listen(port, () => {
    console.log(`MCP Server listening on http://localhost:${port}`);
    if (!process.env.GEMINI_API_KEY) {
        console.warn("Warning: GEMINI_API_KEY is not set in the environment. API calls will fail.");
    }
});

// Basic error handling for unhandled promise rejections or uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally exit process or implement more robust error handling/logging
    // process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Optionally exit process or implement more robust error handling/logging
    // process.exit(1);
});