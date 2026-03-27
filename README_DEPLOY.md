# WDP 知识引擎 - 公网部署指南

## 简介

本文档指导如何将 WDP 知识引擎部署到公网服务器，供外部用户访问。

## 环境要求

- Ubuntu 20.04/22.04 LTS（推荐）
- 2核CPU / 4GB内存 / 20GB磁盘
- 固定公网IP地址
- 域名（如 wdp-knowledge.yourcompany.com）
- SSL证书（使用 Let's Encrypt 免费证书）

## 准备工作

向IT/运维部门申请：

```
服务器配置：
- 操作系统：Ubuntu 20.04/22.04 LTS
- CPU：2核，内存：4GB，磁盘：20GB
- 网络：固定公网IP，开放80/443/3000端口
- 域名：wdp-knowledge.yourcompany.com

软件安装：
1. Node.js 18+
2. Nginx（反向代理）
3. PM2（进程管理）
4. Certbot（SSL证书）
5. Git

防火墙配置：
- 允许：22(SSH), 80(HTTP), 443(HTTPS)
- 限制：3000端口仅允许本机访问
```

## 部署步骤

### 第一步：安装基础软件

登录服务器，执行：

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Nginx
sudo apt install -y nginx

# 安装 PM2
sudo npm install -g pm2

# 安装 Certbot（SSL证书工具）
sudo apt install -y certbot python3-certbot-nginx
```

### 第二步：部署应用代码

```bash
# 创建应用目录
sudo mkdir -p /opt/wdp-mcp-server
sudo chown -R $USER:$USER /opt/wdp-mcp-server

# 上传代码（在本地执行）
# scp -r mcp-knowledge-server/ user@server:/opt/wdp-mcp-server/

# 在服务器上安装依赖
cd /opt/wdp-mcp-server/mcp-knowledge-server
npm install
npm run build
```

### 第三步：配置 Nginx 反向代理

创建配置文件：

```bash
sudo nano /etc/nginx/sites-available/wdp-mcp-server
```

写入内容：

```nginx
server {
    listen 80;
    server_name wdp-knowledge.yourcompany.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name wdp-knowledge.yourcompany.com;

    ssl_certificate /etc/letsencrypt/live/wdp-knowledge.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wdp-knowledge.yourcompany.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/wdp-mcp-server /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 第四步：申请 SSL 证书

```bash
sudo certbot --nginx -d wdp-knowledge.yourcompany.com
```

按提示完成证书申请。

### 第五步：启动服务

```bash
cd /opt/wdp-mcp-server/mcp-knowledge-server

# 创建环境配置文件
cat > .env << EOF
PORT=3000
HOST=127.0.0.1
VALID_TOKENS=demo-token:private:管理员
ADMIN_TOKEN=your-secret-admin-token
EOF

# 使用 PM2 启动
pm2 start dist/server.js --name wdp-mcp-server

# 保存配置
pm2 save

# 设置开机自启
pm2 startup
```

### 第六步：配置防火墙

```bash
# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 禁止外网直接访问 3000 端口（只能通过 Nginx 访问）
sudo ufw deny 3000/tcp

# 启用防火墙
sudo ufw enable
```

## 客户端配置

部署完成后，告诉客户端用户：

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": ["C:/.../mcp-proxy-client.js"],
      "env": {
        "WDP_SERVER_URL": "https://wdp-knowledge.yourcompany.com",
        "WDP_KNOWLEDGE_TOKEN": "用户Token"
      }
    }
  }
}
```

## 日常维护

### 查看日志

```bash
# 应用日志
pm2 logs wdp-mcp-server

# Nginx 日志
sudo tail -f /var/log/nginx/error.log
```

### 重启服务

```bash
pm2 restart wdp-mcp-server
```

### 更新服务器

```bash
cd /opt/wdp-mcp-server/mcp-knowledge-server
git pull
npm install
npm run build
pm2 restart wdp-mcp-server
```

### 备份数据

```bash
# 备份 Token 数据
cp config/tokens.json ~/backup/tokens-$(date +%Y%m%d).json
```

## 故障排查

### 502 Bad Gateway

```bash
# 检查服务是否运行
pm2 status
pm2 logs

# 重启服务
pm2 restart wdp-mcp-server
```

### SSL 证书过期

```bash
# 续期证书
sudo certbot renew
sudo systemctl restart nginx
```

### 内存占用过高

```bash
# 重启服务释放内存
pm2 restart wdp-mcp-server

# 或设置内存限制自动重启
pm2 start dist/server.js --name wdp-mcp-server --max-memory-restart 512M
```

## 安全建议

- [ ] SSL 证书已配置
- [ ] 3000 端口不暴露给外网
- [ ] 防火墙已启用
- [ ] 管理员 Token 使用强密码
- [ ] 定期审计 Token 使用情况
- [ ] 启用日志监控
- [ ] 配置自动备份
