import express, { Request, Response, RequestHandler } from 'express';
import dotenv from 'dotenv';
import { handleMcpRequest } from './mcp_handler'; // Import the handler
import { 
    getScreenshotRecord, 
    getScreenshotUrl, 
    getScreenshotsByTag, 
    getScreenshotsByMetadata,
    ScreenshotRecord
} from './supabase_handler';

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
    const { url, prompt } = req.body;

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

    console.log(`Received request: URL=${url}, Prompt="${prompt}"`);

    try {
        const startTime = Date.now();
        const geminiResponse = await handleMcpRequest(url, prompt);
        const duration = (Date.now() - startTime) / 1000;

        console.log(`Successfully processed request in ${duration.toFixed(2)} seconds.`);
        res.status(200).json({ 
            response: geminiResponse,
            message: "Screenshot and metadata have been saved in the data/screenshots directory"
        });

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

// --- Screenshot Endpoints ---
// Get screenshot URL by ID
app.get('/screenshots/:id', (async (req: Request, res: Response) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid ID format' });
        }
        
        const screenshot = await getScreenshotRecord(id);
        
        if (!screenshot) {
            return res.status(404).json({ error: `Screenshot with ID ${id} not found` });
        }
        
        const url = await getScreenshotUrl(screenshot.screenshot_path);
        
        res.status(200).json({ 
            id: screenshot.id,
            url: screenshot.url,
            prompt: screenshot.prompt,
            created_at: screenshot.created_at,
            tags: screenshot.tags || [],
            metadata: screenshot.metadata || {},
            download_url: url
        });
    } catch (error) {
        console.error("Error retrieving screenshot:", error);
        const message = error instanceof Error ? error.message : "An unknown error occurred";
        res.status(500).json({ error: message });
    }
}) as RequestHandler);

// Get screenshots with filters
app.get('/screenshots', (async (req: Request, res: Response) => {
    try {
        const { tag, key, value } = req.query;
        
        let screenshots = [];
        
        // Filter by tag
        if (tag && typeof tag === 'string') {
            screenshots = await getScreenshotsByTag(tag);
        }
        // Filter by metadata
        else if (key && value && typeof key === 'string' && typeof value === 'string') {
            // Try to parse value as JSON if it seems to be a complex type
            let parsedValue = value;
            if ((value.startsWith('{') && value.endsWith('}')) || 
                (value.startsWith('[') && value.endsWith(']'))) {
                try {
                    parsedValue = JSON.parse(value);
                } catch (e) {
                    // Use the original string value if parsing fails
                }
            }
            screenshots = await getScreenshotsByMetadata(key, parsedValue);
        }
        // No valid filters
        else {
            return res.status(400).json({ 
                error: 'Invalid query parameters. Use "tag" or "key" and "value" parameters'
            });
        }
        
        // Get download URLs for all screenshots
        const results = await Promise.all(
            screenshots.map(async (screenshot: ScreenshotRecord) => {
                const downloadUrl = await getScreenshotUrl(screenshot.screenshot_path);
                return {
                    id: screenshot.id,
                    url: screenshot.url,
                    prompt: screenshot.prompt,
                    created_at: screenshot.created_at,
                    tags: screenshot.tags || [],
                    metadata: screenshot.metadata || {},
                    download_url: downloadUrl
                };
            })
        );
        
        res.status(200).json({ 
            count: results.length,
            screenshots: results
        });
    } catch (error) {
        console.error("Error retrieving screenshots:", error);
        const message = error instanceof Error ? error.message : "An unknown error occurred";
        res.status(500).json({ error: message });
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
    process.exit(1);
});