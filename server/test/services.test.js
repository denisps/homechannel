import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { FileService } from '../node_modules/files/index.js';
import { ServiceRouter } from '../services/index.js';
import os from 'os';

describe('File Service', () => {
  let testDir;
  let fileService;

  before(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), 'homechannel-test-' + Date.now());
    await fsPromises.mkdir(testDir, { recursive: true });
    
    fileService = new FileService({
      rootDir: testDir,
      allowedDirs: [testDir],
      maxFileSize: 1024 * 1024 // 1MB for testing
    });
  });

  after(async () => {
    // Clean up test directory
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Path validation', () => {
    it('should validate paths within allowed directories', async () => {
      const validPath = path.join(testDir, 'test.txt');
      const result = fileService.validatePath(validPath);
      assert.strictEqual(result, validPath);
    });

    it('should reject path traversal attempts with ..', async () => {
      assert.throws(
        () => fileService.validatePath(testDir + '/../evil.txt'),
        { message: 'Path traversal not allowed' }
      );
    });

    it('should reject paths outside allowed directories', async () => {
      const fileServiceRestricted = new FileService({
        rootDir: testDir,
        allowedDirs: [path.join(testDir, 'restricted')],
        maxFileSize: 1024
      });
      
      assert.throws(
        () => fileServiceRestricted.validatePath(path.join(testDir, 'test.txt')),
        { message: 'Access denied: path outside allowed directories' }
      );
    });
  });

  describe('listDirectory', () => {
    it('should list files and directories', async () => {
      // Create test files and directories
      const subDir = path.join(testDir, 'subdir');
      await fsPromises.mkdir(subDir);
      await fsPromises.writeFile(path.join(testDir, 'file1.txt'), 'content1');
      await fsPromises.writeFile(path.join(testDir, 'file2.txt'), 'content2');

      const result = await fileService.listDirectory({ path: testDir });
      
      assert.ok(result.items);
      assert.ok(result.items.length >= 3);
      
      const file1 = result.items.find(item => item.name === 'file1.txt');
      assert.ok(file1);
      assert.strictEqual(file1.type, 'file');
      assert.strictEqual(file1.size, 8);
      
      const subdirItem = result.items.find(item => item.name === 'subdir');
      assert.ok(subdirItem);
      assert.strictEqual(subdirItem.type, 'directory');
    });

    it('should throw error for non-existent directory', async () => {
      await assert.rejects(
        fileService.listDirectory({ path: path.join(testDir, 'nonexistent') }),
        { message: 'Directory not found' }
      );
    });
  });

  describe('readFile', () => {
    it('should read text file with UTF-8 encoding', async () => {
      const filePath = path.join(testDir, 'text.txt');
      await fsPromises.writeFile(filePath, 'Hello World');

      const result = await fileService.readFile({ path: filePath });
      
      assert.strictEqual(result.content, 'Hello World');
      assert.strictEqual(result.encoding, 'utf8');
      assert.strictEqual(result.size, 11);
      assert.strictEqual(result.mimeType, 'text/plain');
    });

    it('should read binary file with base64 encoding', async () => {
      const filePath = path.join(testDir, 'binary.bin');
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await fsPromises.writeFile(filePath, binaryData);

      const result = await fileService.readFile({ path: filePath });
      
      assert.strictEqual(result.encoding, 'base64');
      assert.strictEqual(result.content, binaryData.toString('base64'));
      assert.strictEqual(result.size, 4);
    });

    it('should throw error for files exceeding max size', async () => {
      const filePath = path.join(testDir, 'large.txt');
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB
      await fsPromises.writeFile(filePath, largeContent);

      await assert.rejects(
        fileService.readFile({ path: filePath }),
        { message: /File too large/ }
      );
    });

    it('should throw error for non-existent file', async () => {
      await assert.rejects(
        fileService.readFile({ path: path.join(testDir, 'missing.txt') }),
        { message: 'File not found' }
      );
    });

    it('should throw error when trying to read directory', async () => {
      await assert.rejects(
        fileService.readFile({ path: testDir }),
        { message: 'Not a file' }
      );
    });
  });

  describe('writeFile', () => {
    it('should write text file', async () => {
      const filePath = path.join(testDir, 'write-test.txt');
      const result = await fileService.writeFile({
        path: filePath,
        content: 'Test content',
        encoding: 'utf8'
      });

      assert.ok(result.success);
      assert.strictEqual(result.size, 12);
      
      const content = await fsPromises.readFile(filePath, 'utf8');
      assert.strictEqual(content, 'Test content');
    });

    it('should write binary file from base64', async () => {
      const filePath = path.join(testDir, 'write-binary.bin');
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      
      const result = await fileService.writeFile({
        path: filePath,
        content: binaryData.toString('base64'),
        encoding: 'base64'
      });

      assert.ok(result.success);
      
      const content = await fsPromises.readFile(filePath);
      assert.deepStrictEqual(content, binaryData);
    });

    it('should create parent directories', async () => {
      const filePath = path.join(testDir, 'nested', 'dirs', 'file.txt');
      
      await fileService.writeFile({
        path: filePath,
        content: 'nested',
        encoding: 'utf8'
      });

      const content = await fsPromises.readFile(filePath, 'utf8');
      assert.strictEqual(content, 'nested');
    });

    it('should throw error for content exceeding max size', async () => {
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB
      
      await assert.rejects(
        fileService.writeFile({
          path: path.join(testDir, 'too-large.txt'),
          content: largeContent,
          encoding: 'utf8'
        }),
        { message: /Content too large/ }
      );
    });

    it('should throw error when content is missing', async () => {
      await assert.rejects(
        fileService.writeFile({
          path: path.join(testDir, 'no-content.txt')
        }),
        { message: 'Content is required' }
      );
    });
  });

  describe('deleteFile', () => {
    it('should delete existing file', async () => {
      const filePath = path.join(testDir, 'delete-me.txt');
      await fsPromises.writeFile(filePath, 'delete this');

      const result = await fileService.deleteFile({ path: filePath });
      assert.ok(result.success);

      await assert.rejects(
        fsPromises.access(filePath),
        { code: 'ENOENT' }
      );
    });

    it('should throw error for non-existent file', async () => {
      await assert.rejects(
        fileService.deleteFile({ path: path.join(testDir, 'missing.txt') }),
        { message: 'File not found' }
      );
    });

    it('should throw error when trying to delete directory', async () => {
      const dirPath = path.join(testDir, 'dir-not-file');
      await fsPromises.mkdir(dirPath);

      await assert.rejects(
        fileService.deleteFile({ path: dirPath }),
        { message: 'Not a file' }
      );
    });
  });

  describe('createDirectory', () => {
    it('should create new directory', async () => {
      const dirPath = path.join(testDir, 'newdir');
      
      const result = await fileService.createDirectory({ path: dirPath });
      assert.ok(result.success);

      const stats = await fsPromises.stat(dirPath);
      assert.ok(stats.isDirectory());
    });

    it('should throw error for existing directory', async () => {
      const dirPath = path.join(testDir, 'existing');
      await fsPromises.mkdir(dirPath);

      await assert.rejects(
        fileService.createDirectory({ path: dirPath }),
        { message: 'Directory already exists' }
      );
    });
  });

  describe('deleteDirectory', () => {
    it('should delete empty directory', async () => {
      const dirPath = path.join(testDir, 'empty-dir');
      await fsPromises.mkdir(dirPath);

      const result = await fileService.deleteDirectory({ path: dirPath });
      assert.ok(result.success);

      await assert.rejects(
        fsPromises.access(dirPath),
        { code: 'ENOENT' }
      );
    });

    it('should throw error for non-empty directory', async () => {
      const dirPath = path.join(testDir, 'non-empty-dir');
      await fsPromises.mkdir(dirPath);
      await fsPromises.writeFile(path.join(dirPath, 'file.txt'), 'data');

      await assert.rejects(
        fileService.deleteDirectory({ path: dirPath }),
        { message: 'Directory not empty' }
      );
    });

    it('should throw error when trying to delete file', async () => {
      const filePath = path.join(testDir, 'file-not-dir.txt');
      await fsPromises.writeFile(filePath, 'content');

      await assert.rejects(
        fileService.deleteDirectory({ path: filePath }),
        { message: 'Not a directory' }
      );
    });
  });

  describe('getFileInfo', () => {
    it('should get file metadata', async () => {
      const filePath = path.join(testDir, 'info-test.txt');
      await fsPromises.writeFile(filePath, 'metadata');

      const result = await fileService.getFileInfo({ path: filePath });
      
      assert.strictEqual(result.name, 'info-test.txt');
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.size, 8);
      assert.ok(result.modified > 0);
      assert.ok(result.permissions);
      assert.strictEqual(result.permissions.readable, true);
    });

    it('should get directory metadata', async () => {
      const dirPath = path.join(testDir, 'info-dir');
      await fsPromises.mkdir(dirPath);

      const result = await fileService.getFileInfo({ path: dirPath });
      
      assert.strictEqual(result.name, 'info-dir');
      assert.strictEqual(result.type, 'directory');
    });

    it('should throw error for non-existent path', async () => {
      await assert.rejects(
        fileService.getFileInfo({ path: path.join(testDir, 'missing') }),
        { message: 'Path not found' }
      );
    });
  });

  describe('MIME type detection', () => {
    it('should detect common MIME types', () => {
      assert.strictEqual(fileService.getMimeType('file.txt'), 'text/plain');
      assert.strictEqual(fileService.getMimeType('file.html'), 'text/html');
      assert.strictEqual(fileService.getMimeType('file.json'), 'application/json');
      assert.strictEqual(fileService.getMimeType('file.png'), 'image/png');
      assert.strictEqual(fileService.getMimeType('file.jpg'), 'image/jpeg');
    });

    it('should return default MIME type for unknown extensions', () => {
      assert.strictEqual(fileService.getMimeType('file.xyz'), 'application/octet-stream');
    });
  });
});

describe('Service Router', () => {
  let testDir;
  let serviceRouter;

  before(async () => {
    testDir = path.join(os.tmpdir(), 'homechannel-router-test-' + Date.now());
    await fsPromises.mkdir(testDir, { recursive: true });
    
    serviceRouter = new ServiceRouter({
      files: {
        enabled: true,
        rootDir: testDir,
        allowedDirs: [testDir],
        maxFileSize: 1024 * 1024
      }
    });
  });

  after(async () => {
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Message handling', () => {
    it('should route message to file service', async () => {
      await fsPromises.writeFile(path.join(testDir, 'route-test.txt'), 'routed');

      const response = await serviceRouter.handleMessage({
        requestId: 'test-123',
        service: 'files',
        operation: 'readFile',
        params: { path: path.join(testDir, 'route-test.txt') }
      });

      assert.ok(response.success);
      assert.strictEqual(response.requestId, 'test-123');
      assert.strictEqual(response.result.content, 'routed');
    });

    it('should handle errors gracefully', async () => {
      const response = await serviceRouter.handleMessage({
        requestId: 'error-123',
        service: 'files',
        operation: 'readFile',
        params: { path: path.join(testDir, 'missing.txt') }
      });

      assert.strictEqual(response.success, false);
      assert.strictEqual(response.requestId, 'error-123');
      assert.strictEqual(response.error, 'File not found');
    });

    it('should validate message structure', async () => {
      const response1 = await serviceRouter.handleMessage({
        service: 'files',
        operation: 'readFile'
      });
      assert.strictEqual(response1.success, false);
      assert.strictEqual(response1.error, 'Missing requestId');

      const response2 = await serviceRouter.handleMessage({
        requestId: 'test'
      });
      assert.strictEqual(response2.success, false);
      assert.strictEqual(response2.error, 'Missing service name');

      const response3 = await serviceRouter.handleMessage({
        requestId: 'test',
        service: 'files'
      });
      assert.strictEqual(response3.success, false);
      assert.strictEqual(response3.error, 'Missing operation name');
    });

    it('should reject unknown service', async () => {
      const response = await serviceRouter.handleMessage({
        requestId: 'test',
        service: 'unknown',
        operation: 'someOp',
        params: {}
      });

      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Unknown service'));
    });

    it('should reject unknown operation', async () => {
      const response = await serviceRouter.handleMessage({
        requestId: 'test',
        service: 'files',
        operation: 'unknownOp',
        params: {}
      });

      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Unknown operation'));
    });
  });

  describe('Service discovery', () => {
    it('should list available services', () => {
      const services = serviceRouter.getAvailableServices();
      
      assert.ok(services.files);
      assert.strictEqual(services.files.enabled, true);
      assert.ok(services.files.operations.includes('listDirectory'));
      assert.ok(services.files.operations.includes('readFile'));
      assert.ok(services.files.operations.includes('writeFile'));
      assert.ok(services.files.operations.includes('deleteFile'));
      assert.ok(services.files.operations.includes('createDirectory'));
      assert.ok(services.files.operations.includes('deleteDirectory'));
      assert.ok(services.files.operations.includes('getFileInfo'));
    });
  });

  describe('Disabled services', () => {
    it('should reject disabled service', async () => {
      const disabledRouter = new ServiceRouter({
        files: {
          enabled: false,
          rootDir: testDir,
          allowedDirs: [testDir]
        }
      });

      const response = await disabledRouter.handleMessage({
        requestId: 'test',
        service: 'files',
        operation: 'readFile',
        params: { path: path.join(testDir, 'test.txt') }
      });

      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Service disabled'));
    });
  });
});
