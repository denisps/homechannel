# HomeChannel Setup Guide

This guide walks you through setting up a complete HomeChannel deployment with coordinator, server, and client.

## Overview

HomeChannel has three components:
1. **Coordinator** (public server) - Facilitates WebRTC signaling
2. **Server** (home network) - Provides access to local services
3. **Client** (browser) - Connects to server through coordinator

## Prerequisites

- **Coordinator**: Public server with Node.js 18+ and open port 3478 (UDP) and 8443 (HTTPS)
- **Server**: Machine on home network with Node.js 18+
- **Client**: Modern browser with WebRTC support (Chrome, Firefox, Edge, Safari)

## Step 1: Set Up Coordinator (Public Server)

### 1.1 Install and Configure

```bash
# Clone repository
git clone https://github.com/denisps/homechannel.git
cd homechannel/coordinator

# Create configuration file
cat > config.json << 'EOF'
{
  "udp": {
    "port": 3478,
    "host": "0.0.0.0"
  },
  "https": {
    "port": 8443,
    "host": "0.0.0.0"
  },
  "serverTimeout": 600000,
  "maxServers": 1000,
  "privateKeyPath": "./coordinator-private.pem",
  "publicKeyPath": "./coordinator-public.pem"
}
EOF

# Run tests to verify installation
npm test
```

### 1.2 Start Coordinator

```bash
node index.js
```

You should see:
```
Coordinator initialized
UDP port: 3478
HTTPS port: 8443
Max servers: 1000
```

### 1.3 Note Coordinator Public Key

The coordinator will generate keys on first run. Save the public key:

```bash
cat coordinator-public.pem
```

You'll need this for the server configuration.

## Step 2: Set Up Server (Home Network)

### 2.1 Install and Configure

```bash
# Clone repository (on home machine)
git clone https://github.com/denisps/homechannel.git
cd homechannel/server

# Copy example configuration
cp config.example.json config.json

# Edit config.json with your settings
nano config.json
```

Edit `config.json`:

```json
{
  "coordinator": {
    "host": "your-coordinator-domain.com",
    "port": 3478,
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  },
  "password": "your-secure-password",
  "privateKeyPath": "./server-private.pem",
  "publicKeyPath": "./server-public.pem",
  "services": {
    "files": {
      "enabled": true,
      "rootDir": "/home/username",
      "allowedDirs": [
        "/home/username/documents",
        "/home/username/downloads"
      ],
      "maxFileSize": 104857600
    }
  }
}
```

**Important:**
- Replace `your-coordinator-domain.com` with your coordinator's domain or IP
- Replace `your-secure-password` with a strong password
- Paste coordinator's public key (from Step 1.3)
- Adjust `allowedDirs` to directories you want to access

### 2.2 Run Tests

```bash
npm test
```

### 2.3 Start Server

```bash
node index.js
```

You should see:
```
Server initialized
Registration sequence initiated
Server registered with coordinator
```

### 2.4 Note Server Public Key

Save the server's public key (shown in logs or in `server-public.pem`):

```bash
cat server-public.pem
```

You'll need this for the client.

## Step 3: Connect with Client (Browser)

### 3.1 Open File Browser

Open `client/apps/filebrowser.html` in your browser.

**Options:**
- Local file: `file:///path/to/homechannel/client/apps/filebrowser.html`
- Or host on a web server: `https://your-domain.com/filebrowser.html`

### 3.2 Enter Connection Details

1. **Coordinator URL**: `https://your-coordinator-domain.com:8443`
2. **Server Public Key**: Paste the server's public key (from Step 2.4)
3. **Password**: Enter the password (from server config.json)

### 3.3 Connect

Click "Connect". You should see:
- Connection status: "Connecting..."
- Then: "Connected to server"
- File list showing your configured directories

### 3.4 Browse Files

You can now:
- Click folders to navigate
- Click "Back" to go to parent directory
- Click "New Folder" to create directories
- Click "Upload" to upload files
- Click "Download" next to files to download them
- Click "Delete" to remove files/folders

## Security Considerations

### Passwords
- Use strong, unique passwords for each server
- Don't reuse passwords across servers
- Consider using a password manager

### Allowed Directories
- Only configure directories you need to access
- Never allow root directory (`/`)
- Use specific subdirectories, not entire home directory

### Coordinator Keys
- Keep coordinator private key secure
- Use file permissions 600: `chmod 600 coordinator-private.pem`
- Back up keys securely

### Server Keys
- Keep server private keys secure
- Use file permissions 600: `chmod 600 server-private.pem`
- Each server should have unique keys

### HTTPS
- Use HTTPS for coordinator (not HTTP)
- Use valid TLS certificates (Let's Encrypt is free)
- Don't accept self-signed certificates in production

## Firewall Configuration

### Coordinator (Public Server)
Open these ports:
- UDP 3478 (for server connections)
- TCP 8443 (HTTPS for client connections)

```bash
# UFW example
sudo ufw allow 3478/udp
sudo ufw allow 8443/tcp
```

### Server (Home Network)
- No incoming ports needed (initiates outbound UDP to coordinator)
- If behind NAT, ensure UDP can traverse firewall
- No port forwarding required

## Troubleshooting

### Server Can't Register

**Symptoms:** "Registration failed" or timeout

**Solutions:**
1. Check coordinator URL and port in server config
2. Verify coordinator is running: `curl https://coordinator:8443/api/coordinator-key`
3. Check firewall allows UDP 3478 outbound
4. Verify coordinator public key is correct

### Client Can't Connect

**Symptoms:** "Connection failed" or "Challenge answer incorrect"

**Solutions:**
1. Check coordinator URL in client
2. Verify server public key is correct (check logs or .pem file)
3. Verify password matches server config
4. Check server is registered: Look for "Server registered" in logs
5. Open browser console (F12) for detailed errors

### WebRTC Connection Fails

**Symptoms:** "Waiting for datachannel" hangs

**Solutions:**
1. Check browser supports WebRTC (try different browser)
2. Verify coordinator can relay ICE candidates
3. Check server WebRTC is working (see server logs)
4. Try disabling browser extensions that block WebRTC

### File Operations Fail

**Symptoms:** "Access denied" or "Path not found"

**Solutions:**
1. Verify path is within `allowedDirs` in server config
2. Check file permissions on server
3. Verify server has read/write access to directories
4. Check maxFileSize if uploading large files

## Advanced Configuration

### Multiple Servers

You can register multiple servers with one coordinator. Each needs:
- Unique keys
- Unique password
- Different configuration file

Client can connect to different servers by using their respective public keys.

### Custom Port Configuration

To use different ports:

**Coordinator:**
```json
{
  "udp": { "port": 12345 },
  "https": { "port": 8080 }
}
```

**Server:**
```json
{
  "coordinator": {
    "port": 12345
  }
}
```

**Client:**
Enter coordinator URL with custom port: `https://coordinator:8080`

### SSL/TLS Certificates

For production, use Let's Encrypt:

```bash
# Get certificate
sudo certbot certonly --standalone -d your-domain.com

# Update coordinator/https.js to use certificates
# (requires code modification to load cert and key)
```

## Monitoring

### Coordinator
```bash
# View logs
tail -f coordinator.log

# Check registered servers
# (requires adding admin endpoint)
```

### Server
```bash
# View logs
tail -f server.log

# Check connection status
# Server logs show registration status
```

## Backup

### Important Files to Backup
- `coordinator-private.pem` (coordinator)
- `coordinator-public.pem` (coordinator)
- `server-private.pem` (each server)
- `server-public.pem` (each server)
- `config.json` (coordinator and servers)

```bash
# Backup keys
tar czf homechannel-keys-backup.tar.gz \
  coordinator/*.pem \
  server/*.pem \
  */config.json

# Store securely (encrypted, offline)
```

## Production Deployment

### Use Process Manager

Use PM2 or systemd to keep services running:

```bash
# Install PM2
npm install -g pm2

# Start coordinator
cd coordinator
pm2 start index.js --name homechannel-coordinator

# Start server
cd ../server
pm2 start index.js --name homechannel-server

# Save configuration
pm2 save

# Auto-start on boot
pm2 startup
```

### Enable Logging

```bash
# PM2 logs
pm2 logs homechannel-coordinator
pm2 logs homechannel-server

# Or use systemd
```

### Set Up Monitoring

Monitor for:
- Service uptime
- Connection failures
- Memory usage
- Disk space (for file services)

## Updates

To update HomeChannel:

```bash
# Backup current version
cp -r homechannel homechannel-backup

# Pull updates
cd homechannel
git pull

# Update dependencies
cd coordinator && npm install
cd ../server && npm install

# Run tests
npm test

# Restart services
pm2 restart all
```

## Getting Help

- **Documentation**: See [docs/](docs/) directory
- **Issues**: https://github.com/denisps/homechannel/issues
- **Security**: Report security issues privately to maintainers

## Next Steps

- Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand the system
- Review [SECURITY.md](docs/SECURITY.md) for security best practices
- Explore [FILE_SERVICE.md](server/FILE_SERVICE.md) for file service API
- Check [client API docs](client/README.md) to build custom apps
