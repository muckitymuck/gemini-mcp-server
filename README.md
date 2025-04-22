# Gemini MCP Server

Multi-context processing (MCP) server using Gemini API for analyzing webpages.

## Features

- Screenshot and analyze webpages
- Tag and metadata for screenshots
- Retrieve screenshots and associated data via API

## API Endpoints

### Process a webpage

```
POST /process
```

Request body:
```json
{
  "url": "https://example.com",
  "prompt": "Describe what you see on this webpage"
}
```

### Get screenshots

#### Get screenshot by ID

```
GET /screenshots/:id
```

Example:
```
GET /screenshots/123
```

Response:
```json
{
  "id": 123,
  "url": "https://example.com",
  "prompt": "Describe what you see on this webpage",
  "created_at": "2023-06-15T12:34:56Z",
  "tags": ["initial_load", "page_entry"],
  "metadata": {
    "pageState": "initial",
    "pageTitle": "Example Domain"
  },
  "download_url": "https://yoursupabaseproject.supabase.co/storage/v1/object/public/screenshots/screenshot_1234.png"
}
```

#### Get screenshots with filters

```
GET /screenshots?tag=initial_load
```

or

```
GET /screenshots?key=pageTitle&value=Example%20Domain
```

Response:
```json
{
  "count": 2,
  "screenshots": [
    {
      "id": 123,
      "url": "https://example.com",
      "prompt": "Describe what you see on this webpage",
      "created_at": "2023-06-15T12:34:56Z",
      "tags": ["initial_load", "page_entry"],
      "metadata": {
        "pageState": "initial",
        "pageTitle": "Example Domain"
      },
      "download_url": "https://yoursupabaseproject.supabase.co/storage/v1/object/public/screenshots/screenshot_1234.png"
    },
    // Additional screenshots...
  ]
}
```

## Installation

1. Clone the repository
2. Create a `.env` file based on `.env.example`
3. Run `npm install`
4. Run `npm run build`
5. Start the server with `npm start` 