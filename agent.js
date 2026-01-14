#!/usr/bin/env node

// Load environment variables from .env file
require('dotenv').config();

const { exec } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const execAsync = promisify(exec);

// Detect platform
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// Configuration
const config = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
  serverId: process.env.SERVER_ID || '',
  heartbeatInterval: 30000, // 30 seconds
  apiKey: process.env.API_KEY || '', // Optional API key for authentication
  wsUrl: process.env.WS_URL || null, // Optional WebSocket URL for real-time commands
  agentPort: parseInt(process.env.AGENT_PORT || '3001', 10) // Agent HTTP server port
};

// Create Express app
const app = express();
app.use(express.json());

// Validate configuration
if (!config.serverId) {
  console.error('❌ Error: SERVER_ID environment variable is required');
  process.exit(1);
}

// Check WireGuard installation on Linux
async function checkWireGuardInstallation() {
  if (isWindows) {
    return { installed: false, message: 'Windows platform - WireGuard commands not available' };
  }
  
  try {
    // Check if wg command exists
    await execAsync('which wg');
    return { installed: true, message: 'WireGuard is installed' };
  } catch (error) {
    return { 
      installed: false, 
      message: 'WireGuard (wg) command not found. Please install WireGuard: sudo apt install wireguard (Ubuntu/Debian) or sudo yum install wireguard-tools (CentOS/RHEL)' 
    };
  }
}

// Get WireGuard status (detailed)
async function getWireGuardStatus() {
  try {
    // Check if WireGuard is running by counting active peers
    const { stdout } = await execAsync('wg show wg0');
    const lines = stdout.trim().split('\n');
    
    // Parse output for detailed status
    let port = null;
    let peerCount = 0;
    let lastHandshake = null;
    let latestHandshakeTime = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Check for listening port
      if (trimmed.startsWith('listening port:')) {
        const portMatch = trimmed.match(/listening port:\s*(\d+)/);
        if (portMatch) {
          port = parseInt(portMatch[1], 10);
        }
      }
      
      // Check for peer (starts with "peer:")
      if (trimmed.startsWith('peer:')) {
        peerCount++;
      }
      
      // Check for latest handshake
      if (trimmed.startsWith('latest handshake:')) {
        const handshakeMatch = trimmed.match(/latest handshake:\s*(.+)/);
        if (handshakeMatch) {
          const handshakeStr = handshakeMatch[1].trim();
          // Keep the most recent handshake
          if (!lastHandshake || handshakeStr.length > lastHandshake.length) {
            lastHandshake = handshakeStr;
          }
        }
      }
    }
    
    // Check if wg0 interface exists and is up
    // WireGuard interfaces can show as UP, UNKNOWN, or have LOWER_UP flag
    const { stdout: linkStatus } = await execAsync('ip link show wg0 2>/dev/null || echo ""');
    const isRunning = linkStatus.includes('wg0') && (
      linkStatus.includes('state UP') || 
      linkStatus.includes('state UNKNOWN') || 
      linkStatus.includes('LOWER_UP')
    );
    
    return {
      status: isRunning ? 'up' : 'down',
      interface: 'wg0',
      port: port,
      peers: peerCount,
      lastHandshake: lastHandshake,
      running: isRunning,
      raw: stdout
    };
  } catch (error) {
    // WireGuard is not running or not installed
    return {
      status: 'down',
      interface: 'wg0',
      port: null,
      peers: 0,
      lastHandshake: null,
      running: false,
      error: error.message
    };
  }
}

// Get WireGuard status (simple - for heartbeat)
async function getWireGuardStatusSimple() {
  try {
    const { stdout } = await execAsync('wg show');
    const lines = stdout.trim().split('\n');
    const peerCount = lines.filter(line => line.trim().startsWith('peer:')).length;
    const { stdout: linkStatus } = await execAsync('ip link show wg0 2>/dev/null || echo ""');
    // WireGuard interfaces can show as UP, UNKNOWN, or have LOWER_UP flag
    const isRunning = linkStatus.includes('wg0') && (
      linkStatus.includes('state UP') || 
      linkStatus.includes('state UNKNOWN') || 
      linkStatus.includes('LOWER_UP')
    );
    
    return {
      running: isRunning,
      peerCount: peerCount,
      raw: stdout
    };
  } catch (error) {
    return {
      running: false,
      peerCount: 0,
      raw: ''
    };
  }
}

// Get system load
async function getSystemLoad() {
  // Windows doesn't have /proc/loadavg, return 0 silently
  if (isWindows) {
    return 0;
  }
  
  try {
    // Get CPU load (1-minute average)
    const { stdout: loadavg } = await execAsync('cat /proc/loadavg');
    const loadValues = loadavg.trim().split(/\s+/);
    const load1Min = parseFloat(loadValues[0]) || 0;
    
    // Convert to percentage (assuming single core, adjust based on CPU count)
    const { stdout: cpuCount } = await execAsync('nproc');
    const cpuCores = parseInt(cpuCount.trim()) || 1;
    const loadPercentage = Math.min((load1Min / cpuCores) * 100, 100);
    
    return loadPercentage;
  } catch (error) {
    // Silently return 0 on error (don't log on Windows)
    return 0;
  }
}

// Get CPU usage percentage
async function getCPUUsage() {
  // Windows doesn't have these commands, return 0 silently
  if (isWindows) {
    return 0;
  }
  
  try {
    // Method 1: Using top command (more accurate)
    const { stdout } = await execAsync("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'");
    const cpuUsage = parseFloat(stdout.trim());
    if (!isNaN(cpuUsage) && cpuUsage >= 0 && cpuUsage <= 100) {
      return cpuUsage;
    }
  } catch (error) {
    // Fallback method
  }
  
  // Method 2: Using /proc/stat (fallback)
  try {
    const { stdout: stat1 } = await execAsync("cat /proc/stat | head -1");
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    const { stdout: stat2 } = await execAsync("cat /proc/stat | head -1");
    
    const parseStat = (line) => {
      const parts = line.split(/\s+/);
      return {
        user: parseInt(parts[1]) || 0,
        nice: parseInt(parts[2]) || 0,
        system: parseInt(parts[3]) || 0,
        idle: parseInt(parts[4]) || 0,
        iowait: parseInt(parts[5]) || 0,
        irq: parseInt(parts[6]) || 0,
        softirq: parseInt(parts[7]) || 0
      };
    };
    
    const cpu1 = parseStat(stat1);
    const cpu2 = parseStat(stat2);
    
    const total1 = cpu1.user + cpu1.nice + cpu1.system + cpu1.idle + cpu1.iowait + cpu1.irq + cpu1.softirq;
    const total2 = cpu2.user + cpu2.nice + cpu2.system + cpu2.idle + cpu2.iowait + cpu2.irq + cpu2.softirq;
    
    const idle1 = cpu1.idle;
    const idle2 = cpu2.idle;
    
    const totalIdle = idle2 - idle1;
    const totalDiff = total2 - total1;
    
    if (totalDiff > 0) {
      const cpuUsage = 100 - (totalIdle / totalDiff) * 100;
      return Math.max(0, Math.min(100, cpuUsage));
    }
  } catch (e) {
    // If all methods fail, return 0
  }
  
  return 0;
}

// Get RAM usage percentage
async function getRAMUsage() {
  // Windows doesn't have 'free' command, return 0 silently
  if (isWindows) {
    return 0;
  }
  
  try {
    const { stdout } = await execAsync("free | grep Mem | awk '{print ($3/$2) * 100.0}'");
    const ramUsage = parseFloat(stdout.trim()) || 0;
    return Math.min(ramUsage, 100);
  } catch (error) {
    // Silently return 0 on error (don't log on Windows)
    return 0;
  }
}

// Send heartbeat to backend
async function sendHeartbeat() {
  try {
    const wgStatus = await getWireGuardStatusSimple();
    const systemLoad = await getSystemLoad();
    const cpuUsage = await getCPUUsage();
    const ramUsage = await getRAMUsage();
    
    // Use system load as the main load metric (0-100)
    const load = systemLoad;
    
    const payload = {
      serverId: config.serverId,
      wgRunning: wgStatus.running,
      load: load,
      activePeers: wgStatus.peerCount,
      metrics: {
        cpuUsage: cpuUsage,
        ramUsage: ramUsage,
        systemLoad: systemLoad
      }
    };
    
    const headers = {};
    if (config.apiKey) {
      headers['X-API-Key'] = config.apiKey;
    }
    
    const response = await axios.post(
      `${config.backendUrl}/agent/heartbeat`,
      payload,
      { headers, timeout: 10000 }
    );
    
    if (response.data.success) {
      console.log(`✅ Heartbeat sent: WG=${wgStatus.running ? 'RUNNING' : 'STOPPED'}, Load=${load.toFixed(1)}%, Peers=${wgStatus.peerCount}`);
    }
    
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error(`❌ Heartbeat failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    } else if (error.request) {
      console.error(`❌ Heartbeat failed: No response from backend (${config.backendUrl})`);
    } else {
      console.error(`❌ Heartbeat error: ${error.message}`);
    }
    return null;
  }
}

// Add WireGuard peer
async function addPeer(publicKey, allowedIPs) {
  try {
    // Add peer to WireGuard
    // Note: This is a simplified version. In production, you'd want to:
    // 1. Generate private key if needed
    // 2. Add to wg0 interface
    // 3. Update configuration file
    // 4. Save configuration
    
    const command = `wg set wg0 peer ${publicKey} allowed-ips ${allowedIPs || '10.0.0.2/32'}`;
    await execAsync(command);
    
    // Save configuration (if using wg-quick)
    try {
      await execAsync('wg-quick save wg0');
    } catch (e) {
      // wg-quick save might not be available, that's okay
      console.log('Note: Could not save WireGuard config automatically');
    }
    
    console.log(`✅ Peer added: ${publicKey.substring(0, 16)}...`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to add peer: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Remove WireGuard peer
async function removePeer(publicKey) {
  try {
    // Remove peer from WireGuard
    const command = `wg set wg0 peer ${publicKey} remove`;
    await execAsync(command);
    
    // Save configuration (if using wg-quick)
    try {
      await execAsync('wg-quick save wg0');
    } catch (e) {
      // wg-quick save might not be available, that's okay
      console.log('Note: Could not save WireGuard config automatically');
    }
    
    console.log(`✅ Peer removed: ${publicKey.substring(0, 16)}...`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to remove peer: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Note: For HTTP polling-based command checking, you would need to implement:
// - GET /agent/commands/:serverId endpoint on backend
// - Periodic polling (e.g., every 10 seconds)
// - Command queue management
// Currently, we use WebSocket for real-time commands (if configured)

// WebSocket connection for real-time commands
let wsConnection = null;

function connectWebSocket() {
  if (!config.wsUrl) {
    // If no WebSocket URL is configured, use HTTP polling
    return;
  }
  
  try {
    const wsUrl = config.wsUrl.replace('http://', 'ws://').replace('https://', 'wss://');
    const ws = new WebSocket(`${wsUrl}/agent/commands?serverId=${config.serverId}`);
    
    ws.on('open', () => {
      console.log('🔌 WebSocket connected to backend');
      wsConnection = ws;
    });
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'add_peer') {
          const { publicKey, allowedIPs } = message;
          const result = await addPeer(publicKey, allowedIPs);
          ws.send(JSON.stringify({ type: 'peer_added', success: result.success, publicKey }));
        } else if (message.type === 'remove_peer') {
          const { publicKey } = message;
          const result = await removePeer(publicKey);
          ws.send(JSON.stringify({ type: 'peer_removed', success: result.success, publicKey }));
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error.message);
      }
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });
    
    ws.on('close', () => {
      console.log('🔌 WebSocket disconnected, reconnecting in 5 seconds...');
      wsConnection = null;
      setTimeout(connectWebSocket, 5000);
    });
  } catch (error) {
    console.error('WebSocket connection error:', error.message);
  }
}

// HTTP Endpoints
// GET /status - Get WireGuard status
app.get('/status', async (req, res) => {
  try {
    const status = await getWireGuardStatus();
    res.json({
      success: true,
      ...status,
      platform: process.platform,
      isWindows: isWindows,
      // If Windows or error, indicate that WireGuard data is not available
      wireguardAvailable: !isWindows && !status.error
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'down',
      error: error.message,
      platform: process.platform,
      isWindows: isWindows,
      wireguardAvailable: false
    });
  }
});

// GET /health - Health check
app.get('/health', async (req, res) => {
  try {
    const status = await getWireGuardStatus();
    const systemLoad = await getSystemLoad();
    
    let healthStatus = 'down';
    let reason = '';
    
    if (status.status === 'down') {
      healthStatus = 'down';
      reason = 'WireGuard interface is down';
    } else if (status.peers === 0) {
      healthStatus = 'down';
      reason = 'No peers connected';
    } else if (!status.lastHandshake) {
      healthStatus = 'degraded';
      reason = 'No handshake detected';
    } else {
      // Check if handshake is recent (within 2 minutes)
      // Parse handshake time
      const handshakeStr = status.lastHandshake;
      let handshakeTime = null;
      
      if (handshakeStr.includes('ago')) {
        const now = Date.now();
        let seconds = 0;
        const minutesMatch = handshakeStr.match(/(\d+)\s*minute/);
        const secondsMatch = handshakeStr.match(/(\d+)\s*second/);
        if (minutesMatch) seconds += parseInt(minutesMatch[1], 10) * 60;
        if (secondsMatch) seconds += parseInt(secondsMatch[1], 10);
        handshakeTime = now - (seconds * 1000);
      }
      
      if (handshakeTime && (Date.now() - handshakeTime) > 2 * 60 * 1000) {
        healthStatus = 'degraded';
        reason = `Last handshake was more than 2 minutes ago (${handshakeStr})`;
      } else {
        healthStatus = 'healthy';
        reason = `WireGuard is healthy. ${status.peers} peer(s) connected`;
      }
    }
    
    res.json({
      success: true,
      status: healthStatus,
      reason: reason,
      wireguard: status,
      systemLoad: systemLoad,
      platform: process.platform,
      isWindows: isWindows,
      wireguardAvailable: !isWindows && !status.error
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'down',
      reason: error.message
    });
  }
});

// GET /peers - Get peer list
app.get('/peers', async (req, res) => {
  try {
    const { stdout } = await execAsync('wg show wg0');
    const lines = stdout.split('\n').filter(line => line.trim());
    
    const peers = [];
    let currentPeer = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('peer:')) {
        if (currentPeer) {
          peers.push(currentPeer);
        }
        currentPeer = {
          publicKey: trimmed.replace('peer:', '').trim(),
          endpoint: null,
          allowedIPs: null,
          latestHandshake: null,
          transfer: {
            received: null,
            sent: null
          }
        };
      } else if (currentPeer) {
        if (trimmed.startsWith('endpoint:')) {
          currentPeer.endpoint = trimmed.replace('endpoint:', '').trim();
        } else if (trimmed.startsWith('allowed ips:')) {
          currentPeer.allowedIPs = trimmed.replace('allowed ips:', '').trim();
        } else if (trimmed.startsWith('latest handshake:')) {
          currentPeer.latestHandshake = trimmed.replace('latest handshake:', '').trim();
        } else if (trimmed.startsWith('transfer:')) {
          const transferMatch = trimmed.match(/transfer:\s*(\d+\.?\d*\s*\w+)\s*received,\s*(\d+\.?\d*\s*\w+)\s*sent/);
          if (transferMatch) {
            currentPeer.transfer.received = transferMatch[1].trim();
            currentPeer.transfer.sent = transferMatch[2].trim();
          }
        }
      }
    }
    
    if (currentPeer) {
      peers.push(currentPeer);
    }
    
    res.json({
      success: true,
      peers: peers,
      count: peers.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      peers: [],
      count: 0,
      error: error.message
    });
  }
});

// GET /service - Get service status
app.get('/service', async (req, res) => {
  try {
    const { stdout } = await execAsync('systemctl is-active wg-quick@wg0');
    const status = stdout.trim().toLowerCase();
    
    res.json({
      success: true,
      service: status === 'active' ? 'running' : 'stopped'
    });
  } catch (error) {
    // systemctl returns non-zero exit code if service is not active
    if (error.code === 3 || error.code === 1) {
      res.json({
        success: true,
        service: 'stopped'
      });
    } else {
      res.status(500).json({
        success: false,
        service: 'stopped',
        error: error.message
      });
    }
  }
});

// GET /port - Check UDP port
app.get('/port', async (req, res) => {
  try {
    const port = parseInt(req.query.port || '51820', 10);
    
    // Try ss command first
    try {
      const { stdout } = await execAsync(`ss -uln | grep :${port}`);
      if (stdout && stdout.trim()) {
        return res.json({
          success: true,
          udpListening: true,
          port: port
        });
      }
    } catch (ssError) {
      // Try netstat
      try {
        const { stdout } = await execAsync(`netstat -uln | grep :${port}`);
        if (stdout && stdout.trim()) {
          return res.json({
            success: true,
            udpListening: true,
            port: port
          });
        }
      } catch (netstatError) {
        // Port not listening
      }
    }
    
    res.json({
      success: true,
      udpListening: false,
      port: port
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      udpListening: false,
      port: parseInt(req.query.port || '51820', 10),
      error: error.message
    });
  }
});

// Main agent loop
async function startAgent() {
  console.log('🚀 Vexira VPN Agent starting...');
  console.log(`🖥️  Platform: ${process.platform}${isWindows ? ' (Windows - WireGuard commands will not work)' : ''}`);
  console.log(`📡 Backend URL: ${config.backendUrl}`);
  console.log(`🆔 Server ID: ${config.serverId}`);
  console.log(`⏱️  Heartbeat interval: ${config.heartbeatInterval / 1000}s`);
  console.log(`🌐 HTTP Server port: ${config.agentPort}`);
  
  // Check WireGuard installation
  if (!isWindows) {
    const wgCheck = await checkWireGuardInstallation();
    if (wgCheck.installed) {
      console.log(`✅ ${wgCheck.message}`);
    } else {
      console.log(`⚠️  ${wgCheck.message}`);
    }
  } else {
    console.log(`⚠️  Note: Running on Windows. WireGuard commands require Linux. System metrics will be limited.`);
  }
  
  // Start HTTP server
  app.listen(config.agentPort, '0.0.0.0', () => {
    console.log(`✅ Agent HTTP server listening on port ${config.agentPort}`);
    console.log(`   Endpoints: /status, /health, /peers, /service, /port`);
  });
  
  // Send initial heartbeat
  await sendHeartbeat();
  
  // Connect WebSocket if configured
  if (config.wsUrl) {
    connectWebSocket();
  }
  
  // Set up periodic heartbeat
  setInterval(async () => {
    await sendHeartbeat();
  }, config.heartbeatInterval);
  
  console.log('✅ Agent is running. Press Ctrl+C to stop.');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down agent...');
  if (wsConnection) {
    wsConnection.close();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down agent...');
  if (wsConnection) {
    wsConnection.close();
  }
  process.exit(0);
});

// Start the agent
startAgent().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

