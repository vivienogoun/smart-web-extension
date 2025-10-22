# Contextual Browser Agent

An AI-powered Chrome extension that helps you read, comprehend, and refine web content directly in your browser. This extension provides a side panel where you can interact with web pages using natural language commands.

## Features

- 🤖 **AI-Powered Content Processing**: Use natural language to interact with web content
- 📝 **Content Highlighting**: Highlight specific information like dates, names, or any other data
- 🎨 **Side Panel Interface**: Clean, intuitive interface accessible from any tab
- ⚡ **Real-time Processing**: Instantly process and modify page content based on your commands
- 🧠 **Automatic Context Capture**: Text selections from supported pages are added to the conversation context without extra clicks

## Project Structure

```
smart-web-extension/
├── manifest.json           # Extension configuration
├── content-script.js       # Script injected into web pages
├── service-worker.js       # Background service worker
├── sidepanel.html          # Side panel UI
├── sidepanel.js            # Side panel logic
├── icons/                  # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # This file
```

## Prerequisites

- Google Chrome (version 88 or higher) or any Chromium-based browser
- Basic understanding of Chrome extensions (for development)

## Installation & Running Locally

### Step 1: Clone or Download the Project

If you haven't already, download or clone this repository to your local machine.

### Step 2: Open Chrome Extensions Page

1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Alternatively, click the three-dot menu (⋮) → **Extensions** → **Manage Extensions**

### Step 3: Enable Developer Mode

1. In the top-right corner of the Extensions page, toggle on **Developer mode**

### Step 4: Load the Extension

1. Click the **Load unpacked** button that appears after enabling Developer mode
2. Navigate to and select the `smart-web-extension` folder (the root directory containing `manifest.json`)
3. Click **Select Folder**

### Step 5: Verify Installation

1. You should see "Contextual Browser Agent" appear in your list of extensions
2. The extension icon should appear in your Chrome toolbar
3. If you don't see the icon, click the puzzle piece icon (🧩) in the toolbar and pin the extension

## Usage

### Opening the Side Panel

1. Click the extension icon in your Chrome toolbar
2. The side panel will open on the right side of your browser

### Using the Agent

1. Navigate to any web page you want to interact with
2. Open the extension's side panel
3. Enter a command in the text area, for example:
   - "Highlight all dates and company names"
   - "Find all email addresses on this page"
   - "Summarize the main points"
4. Click the **Process Page** button
5. The extension will process your request and modify the page accordingly

## Development

### Making Changes

1. Edit the relevant files in your project directory
2. Save your changes
3. Go to `chrome://extensions/`
4. Click the refresh icon (🔄) on the "Contextual Browser Agent" card
5. Reload any open tabs where you want to test the changes

### Styling with Tailwind CSS

This project uses a local Tailwind build so the extension only ships the purged stylesheet.

1. Install dependencies once with `npm install`
2. Generate the production stylesheet with `npm run build:css`
3. During active development, run `npm run watch:css` to rebuild on every save

The compiled file `sidepanel.css` is linked from `sidepanel.html`.

### File Descriptions

- **manifest.json**: Defines extension metadata, permissions, and configuration
- **service-worker.js**: Handles background tasks and extension lifecycle events
- **content-script.js**: Runs in the context of web pages to interact with page content
- **sidepanel.html**: The HTML structure for the side panel UI
- **sidepanel.js**: JavaScript logic for the side panel interactions

### Debugging

- **Service Worker**: Go to `chrome://extensions/`, find your extension, and click "service worker" to open DevTools
- **Side Panel**: Right-click in the side panel and select "Inspect" to open DevTools
- **Content Script**: Open the page's DevTools (F12) and check the Console for any content script logs

## Permissions

This extension requires the following permissions:

- **activeTab**: Access the currently active tab to read and modify content
- **scripting**: Inject scripts into web pages for content processing
- **sidePanel**: Display the side panel interface
- **storage**: Store user preferences and settings

## Troubleshooting

### Extension doesn't appear after loading

- Ensure Developer mode is enabled
- Verify that you selected the correct folder containing `manifest.json`
- Check for any errors displayed on the extension card

### Side panel doesn't open

- Click the extension icon in the toolbar
- Try reloading the extension from `chrome://extensions/`
- Check the service worker console for errors

### Changes not reflecting

- Always click the refresh icon on the extension card after making changes
- Reload any open tabs where you're testing the extension
- Hard refresh pages with Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)

## Version

Current version: **0.1.0**

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]

## Support

For issues and questions, please [create an issue](https://github.com/vivienogoun/smart-web-extension/issues) on the GitHub repository.
