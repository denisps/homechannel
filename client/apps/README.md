# HomeChannel File Browser

A self-contained web application for browsing and managing files on your home server via HomeChannel's secure WebRTC datachannel.

## Features

- 📁 **Browse Directories** - Navigate through your file system with breadcrumb navigation
- 📤 **Upload Files** - Upload files from your local machine to the home server
- 📥 **Download Files** - Download files from the home server to your local machine
- 📂 **Create Folders** - Create new directories
- 🗑️ **Delete Files/Folders** - Remove files and empty directories
- 🔒 **Secure Connection** - End-to-end encrypted WebRTC datachannel
- 📱 **Responsive Design** - Works on desktop and mobile devices
- 🎨 **Modern UI** - Clean, intuitive interface with smooth animations

## Quick Start

### 1. Open the File Browser

The file browser can run directly from the local filesystem without needing a web server:

```bash
# Simply open the file in your browser:
open client/apps/filebrowser.html

# Or double-click the file in your file explorer
```

**Note:** The app uses script tags instead of ES modules, allowing it to work from `file://` URLs without a web server.

### 2. Connect to Your Server

Fill in the connection form:

- **Coordinator URL**: URL of your HomeChannel coordinator (e.g., `https://coordinator.example.com`)
- **Server Public Key**: Your home server's ECDSA public key in PEM format
- **Password**: The password configured on your home server

Example server public key format:
```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
-----END PUBLIC KEY-----
```

### 3. Browse and Manage Files

Once connected:

- **Navigate**: Double-click folders to open them
- **Go Back**: Click the "Back" button or click on any breadcrumb item
- **Create Folder**: Click "New Folder" button, enter a name
- **Upload Files**: Click "Upload" button, select files
- **Download**: Click download icon on any file
- **Delete**: Click delete icon (folders must be empty)

## Server Configuration

The file browser uses the HomeChannel file service. Configure it on your home server:

```javascript
// server/config.js
export default {
  services: {
    files: {
      enabled: true,
      rootDir: '/home/user',           // Root directory for file access
      allowedDirs: [                   // Allowed directories
        '/home/user',
        '/home/user/documents'
      ],
      maxFileSize: 104857600            // 100MB max file size
    }
  }
};
```

### Security Considerations

- **Path Validation**: The server validates all paths to prevent directory traversal attacks
- **Allowed Directories**: Only directories in `allowedDirs` are accessible
- **File Size Limits**: Maximum file size is enforced (default 100MB)
- **Encryption**: All data is encrypted via WebRTC datachannel
- **Authentication**: Password-based authentication via challenge-response

## File Service Operations

The file browser uses these operations from the file service:

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `listDirectory` | List files and folders | `{ path }` |
| `readFile` | Read file content | `{ path }` |
| `writeFile` | Write file content | `{ path, content, encoding }` |
| `createDirectory` | Create a folder | `{ path }` |
| `deleteFile` | Delete a file | `{ path }` |
| `deleteDirectory` | Delete empty folder | `{ path }` |

## Message Protocol

All operations follow this protocol:

**Request:**
```javascript
{
  requestId: "req_1_1234567890",
  service: "files",
  operation: "listDirectory",
  params: { path: "/home/user/documents" }
}
```

**Response (Success):**
```javascript
{
  requestId: "req_1_1234567890",
  success: true,
  result: {
    items: [
      {
        name: "example.txt",
        type: "file",
        size: 1024,
        modified: 1234567890000
      }
    ]
  }
}
```

**Response (Error):**
```javascript
{
  requestId: "req_1_1234567890",
  success: false,
  error: "Access denied"
}
```

## File Upload

Files are uploaded using the FileReader API:

1. User selects files via file input
2. FileReader reads file as base64 data URL
3. Base64 content is extracted and sent via `writeFile`
4. Server receives and writes file to disk

## File Download

Files are downloaded using the Blob API:

1. Client requests file via `readFile`
2. Server sends file content (base64 for binary, utf8 for text)
3. Client converts to Blob
4. Browser download is triggered via `URL.createObjectURL`

## Browser Compatibility

- Chrome/Edge 80+
- Firefox 75+
- Safari 14+

Requires:
- ES6 modules
- WebRTC DataChannel
- FileReader API
- Blob API
- async/await

## Limitations

- Maximum file size: 100MB (configurable on server)
- Binary file transfer: Uses base64 encoding (adds ~33% overhead)
- Folders must be empty to delete
- No batch operations (yet)
- No file search (yet)

## Development

### Testing

Run the test suite:

```bash
cd client
npm test test/filebrowser.test.js
```

### Customization

All styles are embedded in the HTML file. To customize:

1. Locate the `<style>` section
2. Modify colors, fonts, spacing as needed
3. Update SVG icons in the `<svg><defs>` section

### Adding Features

The file browser is designed to be extensible:

- Add new operations by updating `sendRequest()` calls
- Add new UI elements in the HTML
- Add new event handlers in the script section

## Troubleshooting

### Connection Issues

- Verify coordinator URL is correct
- Check server public key format (should be PEM)
- Ensure server is online and reachable
- Check browser console for errors

### Upload Failures

- Check file size (must be under limit)
- Verify write permissions on server
- Check disk space on server
- Ensure parent directory exists

### Download Failures

- Verify file exists and is readable
- Check file size (large files may timeout)
- Ensure browser allows downloads

### Path Errors

- Paths are relative to server's `rootDir`
- Ensure path is within `allowedDirs`
- Use forward slashes (`/`) not backslashes

## Architecture

### File Structure

The app uses a single universal module file that works in both contexts:

```
client/apps/
├── filebrowser.html   # Main application file
├── client.js          # Universal module (ES module + script tag)
└── README.md          # This file
```

**Note:** The `client.js` file is a universal module that:
- Exports ES module exports (`export { Client, verifySignature, hashChallengeAnswer }`)
- Also exports to `window.HomeChannelClient` when loaded via script tag
- Contains all crypto utilities built-in (no separate crypto-browser.js needed)

### System Architecture

```
┌─────────────┐         ┌──────────────┐         ┌──────────┐
│  Browser    │         │  Coordinator │         │   Home   │
│             │         │   (Public)   │         │  Server  │
│ filebrowser │◄───────►│              │◄───────►│          │
│    .html    │  HTTPS  │   iframe     │   UDP   │  Files   │
│             │  (signaling) │         │         │  Service │
└─────────────┘         └──────────────┘         └──────────┘
       │                                                │
       └────────────────────────────────────────────────┘
                     WebRTC DataChannel
                  (encrypted, peer-to-peer)
```

## License

Same as HomeChannel project.

## Support

For issues or questions, please refer to the main HomeChannel documentation.
