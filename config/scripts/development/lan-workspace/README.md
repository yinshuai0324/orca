# Orca 局域网开发原型

这个入口复用 Orca 仓库的 Electron、SSH2 和 shell 参数处理，从独立窗口连接远端。使用 Orca 的开发环境安装依赖后，在 Mac 的日常开发终端运行 `pnpm exec electron config/scripts/development/lan-workspace/main.mjs`。Electron 使用启动终端的环境来运行你填写的 Mac 启动命令。

1. 填写远程 Linux 机器的 SSH IP、用户名和密码，第一次连接确认主机指纹。
2. 在窗口里选择 Mac 项目目录，填写本机启动命令和预览地址，然后点击 **连接并挂载**。
3. 发一条修改任务。远程 Codex 成功完成后，客户端启动或复用 Mac 开发服务，端口就绪后在 Mac 的默认浏览器打开页面。

远程端需要已有的 SSH 服务、SSHFS/FUSE、`mountpoint`、`fusermount3` 或 `fusermount`，以及已登录的 Codex CLI。客户端通过已认证的 SSH 会话使用 SSHFS 的 passive 模式。它为当前会话分配临时挂载目录，断开时卸载。连接过程保留在用户权限内，开发依赖和测试服务由 Mac 运行。

每个窗口管理一个项目及一段 Codex 会话。连接成功后保留项目与主机设置，SSH 密码只在连接时使用。文件服务只暴露所选目录，跳过环境文件、Git 元数据、`node_modules`、符号链接和硬链接。
