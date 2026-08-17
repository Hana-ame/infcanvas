# 部署注意事项（infcanvas）

> 适用范围：当前仓库通过 **GitHub + Cloudflare Pages** 自动部署。
> 本文记录部署配置、触发方式、注意事项和易踩坑点。

## 1. 当前部署架构

- **代码托管**：GitHub `Hana-ame/infcanvas`
- **自动部署**：Cloudflare Pages
- **生产分支**：`main`
- **项目名**：`infcanvas`
- **访问域名**：
  - `https://infcanvas.pages.dev`
  - `https://infcanvas.moonchan.xyz`
- **构建命令**：`npm run build`
- **输出目录**：`dist`
- **环境变量**：当前无

## 2. 触发方式

- Push 到 `main` 分支 → 自动触发 **production 部署**。
- 创建/更新 Pull Request → 自动生成 **preview 部署**（Cloudflare Pages 会在 PR 评论里给预览链接）。
- 推送其他分支 → 默认也会生成 preview 部署（当前 Cloudflare 配置为 `all`）。

因此**不需要**手动上传 `dist/`，也不需要依赖 GitHub Actions；Cloudflare 会直接从 GitHub 拉取代码并构建。

## 3. 为什么 `/test/` 也能部署

根目录 `vite.config.ts` 已经配置了多页入口：

```ts
rollupOptions: {
  input: {
    main: r('index.html'),
    test: r('test/index.html'),
  },
}
```

所以 `npm run build` 会同时生成：

```text
dist/index.html
dist/test/index.html
dist/assets/test-*.js
```

部署后可以直接访问：

```text
https://infcanvas.pages.dev/test/
```

## 4. 本地验证步骤

推送前建议先本地跑一遍，保证和 Cloudflare 构建结果一致：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Cloudflare Pages 实际执行的是 `npm run build`，该命令已经包含 `tsc --noEmit`，所以类型错误会导致部署失败。

## 5. 易踩坑点

### 5.1 不要提交 `dist/`

`dist/` 已在 `.gitignore` 中，Cloudflare 会自己构建，不需要也不应该把构建产物提交进仓库。

### 5.2 不要依赖 GitHub Actions 检查

当前仓库没有 `.github/workflows/`。部署状态请到 Cloudflare Pages 控制台或通过 API 查看，而不是 GitHub Actions。

### 5.3 修改构建配置要同步 Cloudflare

如果修改了：

- 包管理器（npm/pnpm/yarn）
- Node 版本
- 构建命令
- 输出目录
- 环境变量

需要同步到 Cloudflare Pages 的 **Build settings & deployments** 页面，否则可能部署失败或产物不对。

### 5.4 Cloudflare Pages 是静态托管

本仓库的网页端是纯静态前端。

但联机模式需要 `src/server`（WSS + 权威模拟），这个服务**不能直接跑在 Cloudflare Pages 上**。如果以后要部署联机服务，需要另外部署：

- Cloudflare Workers / Durable Objects
- 或独立 VM / 容器 / Node 服务
- 或其它支持 WebSocket 的平台

`/test/` 是最小核心网页演示，纯客户端运行，不依赖后端，因此可以静态部署。

### 5.5 环境变量

当前 Cloudflare Pages 没有配置环境变量。

如果以后前端需要运行时配置（例如 API 地址），在 Cloudflare Pages 项目设置里添加环境变量，并在代码里通过 `import.meta.env` 读取。

注意：不要把 `LLM_API_KEY` 这类密钥放进前端环境变量，前端变量会暴露给浏览器；密钥只能放在服务端环境。

### 5.6 SPA 路由

当前主游戏是单页应用，但入口就是根 `/`，不存在深层路由，所以暂时不需要额外 SPA fallback。

如果以后加了前端路由（例如 `/play`、`/settings`），需要在 Cloudflare Pages 配置 `_redirects` 或 `404.html` 做 SPA 回退：

```text
/*  /index.html  200
```

### 5.7 自定义域名

当前自定义域名是：

```text
infcanvas.moonchan.xyz
```

如果域名访问异常，检查：

- DNS 记录是否指向 `infcanvas.pages.dev`
- Cloudflare Pages 项目里是否已经添加该域名
- SSL/TLS 证书状态是否为 active

## 6. 如何查看部署状态

- Cloudflare 控制台：`Workers & Pages` → `infcanvas`
- 命令行/API：通过 Cloudflare API 查看 `deployments` 列表
- 每次 production 部署会生成一个唯一部署 URL，例如：

```text
https://01b5f681.infcanvas.pages.dev
```

## 7. 推荐发布流程

```bash
# 1. 本地全量验证
npm run typecheck
npm test
npm run build

# 2. 提交
git add .
git commit -m "..."

# 3. 推送 main
git push origin main

# 4. 到 Cloudflare Pages 确认 production deployment success
```

推完后等 Cloudflare 自动构建完成，访问：

```text
https://infcanvas.pages.dev/
https://infcanvas.pages.dev/test/
```
