import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filebrowserPath = join(__dirname, '../apps/filebrowser.html');

test('filebrowser.html should be valid HTML', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for DOCTYPE
  assert.ok(content.includes('<!DOCTYPE html>'), 'Should have DOCTYPE declaration');
  
  // Check for required meta tags
  assert.ok(content.includes('charset="UTF-8"'), 'Should have UTF-8 charset');
  assert.ok(content.includes('viewport'), 'Should have viewport meta tag');
  
  // Check for title
  assert.ok(content.includes('<title>'), 'Should have a title tag');
  assert.ok(content.includes('HomeChannel File Browser'), 'Should have correct title');
});

test('filebrowser.html should have required UI elements', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Connect view elements
  assert.ok(content.includes('id="connect-view"'), 'Should have connect view');
  assert.ok(content.includes('id="coordinator-url"'), 'Should have coordinator URL input');
  assert.ok(content.includes('id="server-key"'), 'Should have server key input');
  assert.ok(content.includes('id="password"'), 'Should have password input');
  assert.ok(content.includes('id="connect-btn"'), 'Should have connect button');
  
  // Browser view elements
  assert.ok(content.includes('id="browser-view"'), 'Should have browser view');
  assert.ok(content.includes('id="breadcrumb"'), 'Should have breadcrumb navigation');
  assert.ok(content.includes('id="file-list"'), 'Should have file list');
  assert.ok(content.includes('id="back-btn"'), 'Should have back button');
  assert.ok(content.includes('id="new-folder-btn"'), 'Should have new folder button');
  assert.ok(content.includes('id="upload-btn"'), 'Should have upload button');
  assert.ok(content.includes('id="disconnect-btn"'), 'Should have disconnect button');
  
  // Status and modal
  assert.ok(content.includes('id="status"'), 'Should have status element');
  assert.ok(content.includes('id="modal-overlay"'), 'Should have modal overlay');
  
  // File input
  assert.ok(content.includes('id="file-input"'), 'Should have file input');
});

test('filebrowser.html should have SVG icons', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for icon symbols
  assert.ok(content.includes('id="icon-folder"'), 'Should have folder icon');
  assert.ok(content.includes('id="icon-file"'), 'Should have file icon');
  assert.ok(content.includes('id="icon-back"'), 'Should have back icon');
  assert.ok(content.includes('id="icon-new-folder"'), 'Should have new folder icon');
  assert.ok(content.includes('id="icon-upload"'), 'Should have upload icon');
  assert.ok(content.includes('id="icon-download"'), 'Should have download icon');
  assert.ok(content.includes('id="icon-delete"'), 'Should have delete icon');
  assert.ok(content.includes('id="icon-error"'), 'Should have error icon');
  assert.ok(content.includes('id="icon-success"'), 'Should have success icon');
  assert.ok(content.includes('id="icon-info"'), 'Should have info icon');
});

test('filebrowser.html should import client.js as ES module', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for module script
  assert.ok(content.includes('<script type="module">'), 'Should have ES module script');
  
  // Check for client import
  assert.ok(content.includes("import { Client } from '../client.js'"), 'Should import Client from client.js');
});

test('filebrowser.html should have embedded styles', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for style tag
  assert.ok(content.includes('<style>'), 'Should have embedded styles');
  
  // Check for some key CSS classes
  assert.ok(content.includes('.card'), 'Should have card styles');
  assert.ok(content.includes('.file-list'), 'Should have file-list styles');
  assert.ok(content.includes('.breadcrumb'), 'Should have breadcrumb styles');
  assert.ok(content.includes('.toolbar'), 'Should have toolbar styles');
  assert.ok(content.includes('.modal'), 'Should have modal styles');
});

test('filebrowser.html should have proper script structure', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for key functions
  assert.ok(content.includes('function escapeHtml'), 'Should have escapeHtml function');
  assert.ok(content.includes('function formatFileSize'), 'Should have formatFileSize function');
  assert.ok(content.includes('function formatDate'), 'Should have formatDate function');
  assert.ok(content.includes('function showStatus'), 'Should have showStatus function');
  assert.ok(content.includes('function sendRequest'), 'Should have sendRequest function');
  assert.ok(content.includes('function listDirectory'), 'Should have listDirectory function');
  assert.ok(content.includes('function createFolder'), 'Should have createFolder function');
  assert.ok(content.includes('function deleteItem'), 'Should have deleteItem function');
  assert.ok(content.includes('function uploadFile'), 'Should have uploadFile function');
  assert.ok(content.includes('function downloadFile'), 'Should have downloadFile function');
});

test('filebrowser.html should have responsive design', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for media queries
  assert.ok(content.includes('@media'), 'Should have media queries');
  assert.ok(content.includes('max-width: 768px'), 'Should have mobile breakpoint');
});

test('filebrowser.html should have security measures', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for HTML escaping
  assert.ok(content.includes('escapeHtml'), 'Should have HTML escaping function');
  
  // Check that escapeHtml uses textContent (safe approach)
  assert.ok(content.includes('div.textContent'), 'escapeHtml should use textContent');
});

test('filebrowser.html should use file service protocol', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for file service operations
  assert.ok(content.includes("sendRequest('files'") || content.includes('service,'), 'Should use files service');
  assert.ok(content.includes("'listDirectory'") || content.includes('listDirectory'), 'Should have listDirectory operation');
  assert.ok(content.includes('writeFile'), 'Should have writeFile operation');
  assert.ok(content.includes('readFile'), 'Should have readFile operation');
  assert.ok(content.includes('createDirectory'), 'Should have createDirectory operation');
  assert.ok(content.includes('deleteFile'), 'Should have deleteFile operation');
  assert.ok(content.includes('deleteDirectory'), 'Should have deleteDirectory operation');
});

test('filebrowser.html should handle file upload/download', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Check for FileReader usage (for upload)
  assert.ok(content.includes('FileReader'), 'Should use FileReader for uploads');
  assert.ok(content.includes('readAsDataURL'), 'Should read files as data URL');
  
  // Check for Blob usage (for download)
  assert.ok(content.includes('Blob'), 'Should use Blob for downloads');
  assert.ok(content.includes('createObjectURL'), 'Should create object URL for downloads');
  assert.ok(content.includes('revokeObjectURL'), 'Should revoke object URL after download');
});

test('filebrowser.html should be self-contained', async () => {
  const content = await readFile(filebrowserPath, 'utf8');
  
  // Should not have external CSS
  assert.ok(!content.includes('<link rel="stylesheet"'), 'Should not have external CSS');
  
  // Should have embedded SVG icons
  assert.ok(content.includes('<svg'), 'Should have embedded SVG');
  assert.ok(content.includes('<symbol'), 'Should have SVG symbols');
  
  // Should have embedded styles
  assert.ok(content.includes('<style>'), 'Should have embedded styles');
});
