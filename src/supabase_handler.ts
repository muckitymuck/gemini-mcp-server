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

// Ensure the screenshots bucket exists and has proper settings
async function ensureScreenshotsBucket() {
    try {
        // Try to get bucket info to check if it exists
        const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
        
        if (listError) {
            console.error('Error checking bucket existence:', listError);
            return false;
        }
        
        // Check if screenshots bucket exists
        const screenshotsBucket = buckets.find(bucket => bucket.name === 'screenshots');
        
        // If bucket doesn't exist, create it
        if (!screenshotsBucket) {
            console.log('Creating screenshots bucket...');
            const { error: createError } = await supabaseAdmin.storage.createBucket('screenshots', {
                public: true, // Make files publicly accessible
                fileSizeLimit: 5242880, // 5MB limit
            });
            
            if (createError) {
                console.error('Error creating screenshots bucket:', createError);
                return false;
            }
            
            console.log('Screenshots bucket created successfully.');
        } else {
            console.log('Screenshots bucket already exists.');
            
            // Make sure bucket is public if it already exists
            const { error: updateError } = await supabaseAdmin.storage.updateBucket('screenshots', {
                public: true,
            });
            
            if (updateError) {
                console.error('Error updating bucket settings:', updateError);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Error ensuring screenshots bucket exists:', error);
        return false;
    }
}

// Run bucket check at startup
ensureScreenshotsBucket().then(success => {
    if (success) {
        console.log('Supabase storage is ready for screenshots.');
    } else {
        console.warn('Failed to set up Supabase storage for screenshots. Will use local fallback.');
    }
});

// Types for our data
export interface ScreenshotRecord {
    id?: number;
    url: string;
    prompt: string;
    screenshot_path: string;
    created_at?: string;
    tags?: string[];
    metadata?: Record<string, any>;
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

// Search operations
export async function getScreenshotsByTag(tag: string): Promise<ScreenshotRecord[]> {
    const { data, error } = await supabase
        .from('screenshots')
        .select('*')
        .contains('tags', [tag]);

    if (error) {
        throw new Error(`Failed to get screenshots by tag: ${error.message}`);
    }

    return data || [];
}

export async function getScreenshotsByTags(tags: string[]): Promise<ScreenshotRecord[]> {
    const { data, error } = await supabase
        .from('screenshots')
        .select('*')
        .contains('tags', tags);

    if (error) {
        throw new Error(`Failed to get screenshots by tags: ${error.message}`);
    }

    return data || [];
}

export async function getScreenshotsByMetadata(key: string, value: any): Promise<ScreenshotRecord[]> {
    const { data, error } = await supabase
        .from('screenshots')
        .select('*')
        .contains('metadata', { [key]: value });

    if (error) {
        throw new Error(`Failed to get screenshots by metadata: ${error.message}`);
    }

    return data || [];
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
    prompt: string,
    tags?: string[],
    metadata?: Record<string, any>
): Promise<{ record: ScreenshotRecord; publicUrl: string }> {
    // First upload the screenshot
    const fileName = `screenshot_${Date.now()}.png`;
    const storagePath = await uploadScreenshot(fileName, fileBuffer);
    
    // Then create the database record
    const record = await insertScreenshotRecord({
        url,
        prompt,
        screenshot_path: storagePath,
        tags,
        metadata
    });

    // Get the public URL
    const publicUrl = await getScreenshotUrl(storagePath);

    return { record, publicUrl };
} 