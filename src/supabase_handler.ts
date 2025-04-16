import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase clients
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_ANON_KEY in your .env file');
}


// Create both anonymous and service role clients
const supabase = createClient(supabaseUrl, supabaseAnonKey);
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Types for our data
export interface ScreenshotRecord {
    id?: number;
    url: string;
    prompt: string;
    screenshot_path: string;
    created_at?: string;
}

// Table operations
export async function insertScreenshotRecord(record: ScreenshotRecord): Promise<ScreenshotRecord> {
    const { data, error } = await supabaseAdmin
        .from('screenshots')
        .insert([record])
        .select()
        .single();

    if (error) {
        throw new Error(`Failed to insert screenshot record: ${error.message}`);
    }

    return data;
}

export async function getScreenshotRecord(id: number): Promise<ScreenshotRecord | null> {
    const { data, error } = await supabase
        .from('screenshots')
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        throw new Error(`Failed to get screenshot record: ${error.message}`);
    }

    return data;
}

// Storage operations
export async function uploadScreenshot(filePath: string, fileBuffer: Buffer): Promise<string> {
    const fileName = filePath.split('/').pop() || 'screenshot.png';
    const { data, error } = await supabaseAdmin.storage
        .from('screenshots')
        .upload(fileName, fileBuffer, {
            contentType: 'image/png',
            upsert: true
        });

    if (error) {
        throw new Error(`Failed to upload screenshot: ${error.message}`);
    }

    return data.path;
}

export async function getScreenshotUrl(filePath: string): Promise<string> {
    const { data } = supabase.storage
        .from('screenshots')
        .getPublicUrl(filePath);

    return data.publicUrl;
}

// Combined operation to save screenshot and record
export async function saveScreenshotWithRecord(
    fileBuffer: Buffer,
    url: string,
    prompt: string
): Promise<{ record: ScreenshotRecord; publicUrl: string }> {
    // First upload the screenshot
    const fileName = `screenshot_${Date.now()}.png`;
    const storagePath = await uploadScreenshot(fileName, fileBuffer);
    
    // Then create the database record
    const record = await insertScreenshotRecord({
        url,
        prompt,
        screenshot_path: storagePath
    });

    // Get the public URL
    const publicUrl = await getScreenshotUrl(storagePath);

    return { record, publicUrl };
} 