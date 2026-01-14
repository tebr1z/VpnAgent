# Vexira VPN Agent

Linux VPN sunucusu için WireGuard health check ve yönetim agent'ı.

## Özellikler

- ✅ WireGuard durumunu kontrol eder (`wg show`)
- ✅ Sistem yük bilgilerini toplar (CPU, RAM, Load)
- ✅ 30 saniyede bir backend'e heartbeat gönderir
- ✅ Backend'den peer ekle/sil komutlarını alır (WebSocket ile)

## Gereksinimler

- Node.js 14+ veya Node.js 16+
- WireGuard kurulu ve yapılandırılmış
- `wg`, `ip`, `free`, `top` komutları (standart Linux araçları)

## Kurulum

```bash
cd Agent
npm install
```

## Yapılandırma

Environment değişkenleri ile yapılandırılır:

```bash
export BACKEND_URL="http://localhost:5000"
export SERVER_ID="your-server-id-here"
export API_KEY="optional-api-key"  # Opsiyonel
export WS_URL="http://localhost:5000"  # Opsiyonel WebSocket URL
```

### Önemli Notlar

- `SERVER_ID`: MongoDB'deki VpnServer collection'ındaki server ID'si
- `BACKEND_URL`: Backend API URL'i
- `API_KEY`: Backend authentication için (şu anda kullanılmıyor, gelecekte kullanılabilir)
- `WS_URL`: WebSocket URL'i (real-time komutlar için, opsiyonel)

## Çalıştırma

### Manuel

```bash
npm start
```

### Systemd Service Olarak

1. Service dosyası oluştur:

```bash
sudo nano /etc/systemd/system/vexira-agent.service
```

2. İçeriği ekle:

```ini
[Unit]
Description=Vexira VPN Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/Agent
Environment="BACKEND_URL=http://your-backend:5000"
Environment="SERVER_ID=your-server-id"
Environment="WS_URL=http://your-backend:5000"
ExecStart=/usr/bin/node /path/to/Agent/agent.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. Service'i etkinleştir ve başlat:

```bash
sudo systemctl daemon-reload
sudo systemctl enable vexira-agent
sudo systemctl start vexira-agent
sudo systemctl status vexira-agent
```

## Loglar

Agent konsola şu format'ta loglar yazar:

```
✅ Heartbeat sent: WG=RUNNING, Load=45.2%, Peers=12
✅ Peer added: abc123def456...
✅ Peer removed: xyz789uvw012...
❌ Heartbeat failed: 404 - Server not found
```

## WireGuard Komutları

Agent aşağıdaki WireGuard komutlarını kullanır:

- `wg show` - WireGuard durumunu ve peer listesini alır
- `wg set wg0 peer <publicKey> allowed-ips <IP>` - Peer ekler
- `wg set wg0 peer <publicKey> remove` - Peer siler
- `wg-quick save wg0` - Yapılandırmayı kaydeder (varsa)

## Güvenlik Notları

1. **Root Yetkisi**: Agent WireGuard yapılandırmasını değiştirmek için root yetkisi gerektirir
2. **API Key**: Production'da mutlaka API key authentication kullanın
3. **HTTPS/WSS**: Production'da mutlaka HTTPS ve WSS kullanın
4. **Firewall**: Agent'ın sadece backend'e bağlanmasına izin verin

## Sorun Giderme

### WireGuard bulunamıyor

```bash
# WireGuard'ın kurulu olduğundan emin olun
which wg

# wg0 interface'inin var olduğundan emin olun
ip link show wg0
```

### Backend'e bağlanılamıyor

```bash
# Backend URL'in doğru olduğundan emin olun
curl http://your-backend:5000/

# Firewall kurallarını kontrol edin
sudo ufw status
```

### Peer ekle/sil çalışmıyor

- Agent'ın root yetkisiyle çalıştığından emin olun
- WireGuard interface adının `wg0` olduğundan emin olun
- `wg-quick` kurulu olduğundan emin olun (opsiyonel)

## Geliştirme

Agent'ı geliştirme modunda çalıştırmak için:

```bash
npm run dev
```

## Lisans

ISC

