# File Service API

The File Service provides secure file operations over WebRTC datachannel for HomeChannel clients.

## Configuration

Add to `server/config.json`:

```json
{
  "services": {
    "files": {
      "enabled": true,
      "rootDir": "/home/user",
      "allowedDirs": ["/home/user", "/home/user/documents"],
      "maxFileSize": 104857600
    }
  }
}
```

### Configuration Options

- **enabled** (boolean): Enable/disable the file service. Default: `true`
- **rootDir** (string): Root directory for file operations. Default: current working directory
- **allowedDirs** (array): List of allowed directories. Files outside these directories cannot be accessed. Default: `[rootDir]`
- **maxFileSize** (number): Maximum file size in bytes for read/write operations. Default: `104857600` (100MB)

## Message Protocol

All messages follow a request/response pattern over the WebRTC datachannel.

### Request Format

```json
{
  "requestId": "unique-request-id",
  "service": "files",
  "operation": "operationName",
  "params": {
    // operation-specific parameters
  }
}
```

### Response Format

Success:
```json
{
  "requestId": "unique-request-id",
  "success": true,
  "result": {
    // operation-specific result
  }
}
```

Error:
```json
{
  "requestId": "unique-request-id",
  "success": false,
  "error": "Error message"
}
```

## Operations

### listDirectory

List files and directories at the given path.

**Request:**
```json
{
  "requestId": "req-1",
  "service": "files",
  "operation": "listDirectory",
  "params": {
    "path": "/home/user/documents"
  }
}
```

**Response:**
```json
{
  "requestId": "req-1",
  "success": true,
  "result": {
    "items": [
      {
        "name": "file.txt",
        "type": "file",
        "size": 1024,
        "modified": 1704096000000
      },
      {
        "name": "subfolder",
        "type": "directory",
        "size": 4096,
        "modified": 1704096000000
      }
    ]
  }
}
```

**Item Properties:**
- `name` (string): File or directory name
- `type` (string): Either `"file"` or `"directory"`
- `size` (number): Size in bytes
- `modified` (number): Modification time in milliseconds since epoch

### readFile

Read file contents.

**Request:**
```json
{
  "requestId": "req-2",
  "service": "files",
  "operation": "readFile",
  "params": {
    "path": "/home/user/document.txt"
  }
}
```

**Response:**
```json
{
  "requestId": "req-2",
  "success": true,
  "result": {
    "content": "File contents here",
    "encoding": "utf8",
    "mimeType": "text/plain",
    "size": 18
  }
}
```

**Result Properties:**
- `content` (string): File contents (UTF-8 for text, base64 for binary)
- `encoding` (string): Either `"utf8"` or `"base64"`
- `mimeType` (string): Detected MIME type
- `size` (number): File size in bytes

**Binary File Example:**
```json
{
  "content": "iVBORw0KGgoAAAANSUhEUgA...",
  "encoding": "base64",
  "mimeType": "image/png",
  "size": 12345
}
```

### writeFile

Write content to a file.

**Request:**
```json
{
  "requestId": "req-3",
  "service": "files",
  "operation": "writeFile",
  "params": {
    "path": "/home/user/newfile.txt",
    "content": "Hello World",
    "encoding": "utf8"
  }
}
```

**Response:**
```json
{
  "requestId": "req-3",
  "success": true,
  "result": {
    "success": true,
    "size": 11
  }
}
```

**Parameters:**
- `path` (string): File path
- `content` (string): File content (UTF-8 or base64-encoded)
- `encoding` (string): Either `"utf8"` or `"base64"`. Default: `"utf8"`

**Notes:**
- Creates parent directories automatically if they don't exist
- Overwrites existing files
- File permissions set to 0644

### deleteFile

Delete a file.

**Request:**
```json
{
  "requestId": "req-4",
  "service": "files",
  "operation": "deleteFile",
  "params": {
    "path": "/home/user/oldfile.txt"
  }
}
```

**Response:**
```json
{
  "requestId": "req-4",
  "success": true,
  "result": {
    "success": true
  }
}
```

### createDirectory

Create a new directory.

**Request:**
```json
{
  "requestId": "req-5",
  "service": "files",
  "operation": "createDirectory",
  "params": {
    "path": "/home/user/newfolder"
  }
}
```

**Response:**
```json
{
  "requestId": "req-5",
  "success": true,
  "result": {
    "success": true
  }
}
```

**Notes:**
- Does NOT create parent directories (use `writeFile` for that)
- Fails if directory already exists

### deleteDirectory

Delete an empty directory.

**Request:**
```json
{
  "requestId": "req-6",
  "service": "files",
  "operation": "deleteDirectory",
  "params": {
    "path": "/home/user/emptyfolder"
  }
}
```

**Response:**
```json
{
  "requestId": "req-6",
  "success": true,
  "result": {
    "success": true
  }
}
```

**Notes:**
- Directory must be empty
- Fails if directory contains files or subdirectories

### getFileInfo

Get file or directory metadata.

**Request:**
```json
{
  "requestId": "req-7",
  "service": "files",
  "operation": "getFileInfo",
  "params": {
    "path": "/home/user/file.txt"
  }
}
```

**Response:**
```json
{
  "requestId": "req-7",
  "success": true,
  "result": {
    "name": "file.txt",
    "type": "file",
    "size": 1024,
    "modified": 1704096000000,
    "permissions": {
      "readable": true,
      "writable": true
    }
  }
}
```

## Security

The File Service implements multiple security layers:

### Path Validation

1. **Path Traversal Prevention**: Rejects paths containing `..`
2. **Allowed Directory Restriction**: All paths must be within configured `allowedDirs`
3. **Path Resolution**: Uses `path.resolve()` to normalize paths before validation

### Access Control

1. **File Size Limits**: Enforced on both read and write operations
2. **Permission Checks**: Validates read/write permissions before operations
3. **Type Validation**: Ensures operations match file type (file vs directory)

### Error Handling

- **Sanitized Error Messages**: No stack traces or sensitive information sent to client
- **Async Operations**: All file I/O uses `fs.promises` (no blocking)
- **Graceful Failures**: Invalid operations return error responses without crashing

### File Permissions

- Written files: `0644` (owner read/write, group/others read)
- Created directories: System default

## Error Messages

Common error messages returned by the service:

- `"Path traversal not allowed"` - Path contains `..`
- `"Access denied: path outside allowed directories"` - Path not in `allowedDirs`
- `"File too large: X bytes (max: Y)"` - File exceeds `maxFileSize`
- `"Directory not found"` - Directory doesn't exist
- `"File not found"` - File doesn't exist
- `"Not a file"` - Operation expects file but got directory
- `"Not a directory"` - Operation expects directory but got file
- `"Directory not empty"` - Cannot delete non-empty directory
- `"Content is required"` - Missing content parameter in `writeFile`
- `"Access denied"` - Insufficient file system permissions
- `"Directory already exists"` - Cannot create existing directory

## Client Usage Example

```javascript
// Send request
const requestId = crypto.randomUUID();
dataChannel.send(JSON.stringify({
  requestId,
  service: 'files',
  operation: 'listDirectory',
  params: { path: '/home/user/documents' }
}));

// Handle response
dataChannel.addEventListener('message', (event) => {
  const response = JSON.parse(event.data);
  
  if (response.requestId === requestId) {
    if (response.success) {
      console.log('Files:', response.result.items);
    } else {
      console.error('Error:', response.error);
    }
  }
});
```

## Implementation Details

### Files

- `server/services/files.js` - File service implementation
- `server/services/index.js` - Service router
- `server/webrtc.js` - WebRTC peer with datachannel message handling
- `server/index.js` - Server integration
- `server/test/services.test.js` - Comprehensive tests

### Testing

Run tests:
```bash
cd server
npm test
```

Test coverage includes:
- Path validation and security
- All file operations (success and failure cases)
- Message routing
- Error handling
- Service discovery
- Disabled service handling

## Future Enhancements

Potential future additions:

- [ ] File upload/download with chunking for large files
- [ ] File watching for real-time updates
- [ ] Search functionality
- [ ] File compression
- [ ] Symbolic link handling
- [ ] Extended attributes support
- [ ] Batch operations
- [ ] Progress reporting for large operations
