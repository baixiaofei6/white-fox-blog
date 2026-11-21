# 白小飞的个人博客

零依赖 Node 个人博客。只用 Node 内置模块，`npm install` 不需要。

本站是视觉重置版：极简黑白风格（浅灰白底、黑色公告条、横向导航、居中高密度点阵粒子 Hero、克制留白、花瓣纹理装饰），博客内容与功能与原项目完全一致。局域网聊天项目已拆出，本仓库只含博客。

## 获取

`git clone https://github.com/baixiaofei6/white-fox-blog.git`

## 启动

```bash
cp config.example.json config.json   # Windows: Copy-Item config.example.json config.json
npm start                            # 或 node server.js
```

主站 <http://127.0.0.1:8787/>，独立后台 <http://127.0.0.1:8788/>（同机不同端口，主站无后台入口）。
可用环境变量：`PORT`、`ADMIN_PORT`、`HOST`、`DATA_DIR`、`CONFIG_PATH`。

## 功能

- 主站：公告条、高密度点阵粒子文字 Hero（花瓣纹理 + 指针散开）、白天/黑夜/自动三模式、最新动态、专栏、项目矩阵、站点状态、链接、全员可见访客留言板、文章与评论、RSS。
- 独立后台：管理员密码登录（初始账号 `白小飞` / `13135566867.`，末尾句点是密码一部分）、站点文案与配色、首页模块显隐排序、文章/项目/评论/上传/用户/留言管理、改密、背景上传与自定义。
- 只有管理员能改内容；主站不暴露写接口。`config.json` 与 `data/` 不进 Git。

## 自检

```bash
npm test        # 90 passed, 0 failed
```

## 视觉说明

极简黑白风格：黑底公告 40px、导航 max-width 1260px / 高 54px、浅灰底 `#f8f8f8`、细边框 `#e5e5e5`、主色 `#1f2329`。粒子 Hero 文案仍为「你好，我是白小飞 / 写代码，做东西，记录一点想法」，与原博客内容一致。

## 仓库边界

本仓库 = 原 `super-duper-carnival` 中的个人博客部分，已独立拆分发布；局域网聊天项目不在本仓库内。
