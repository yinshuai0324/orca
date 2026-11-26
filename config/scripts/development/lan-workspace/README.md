# Orca 局域网开发原型

从源码启动 Orca 时，在 Mac 的日常开发终端运行 `pnpm dev`。打开 Orca 工作台后，点击 Orca 左下角的设置，选择 **添加远程本地主机**。客户端用启动 Orca 的终端环境运行本机开发服务。

1. 填写远程 Mac 或 Linux 机器的 SSH IP、用户名和密码，第一次连接确认主机指纹。
2. 在窗口里选择 Mac 项目目录，点击 **连接并挂载**。挂载后会在远端打开交互式终端，当前目录是挂载的项目。
3. 在终端里运行远端已有的命令或 AI CLI。需要网页预览时，可以在连接前展开本机预览设置配置命令和地址。连接后点击 **本机启动并预览**，Orca 会启动或复用 Mac 开发服务并打开页面。

**仅打开终端** 可以直接连接到远端主目录。共享 Mac 项目时使用 **连接并挂载**。

远程端需要已有的 SSH 服务和挂载工具。

- macOS 可在远程 Mac 上运行 `brew install --cask sshfs-mac` 安装 SSHFS 和 macFUSE。macOS 15.4 及更新版本使用 FSKit，系统要求时请为 SSH 账号启用 macFUSE 的文件系统扩展。旧版 macOS 使用已获批准的 macFUSE 内核后端。如果 FSKit 提示找不到扩展，按 [macFUSE 排查文档](https://github.com/macfuse/macfuse/wiki/Troubleshooting) 在对应远端账号下注册并启用扩展。
- Linux 端需要 SSHFS/FUSE（SSH 会话可见 `/dev/fuse`）、`fusermount3` 或 `fusermount`。挂载状态通过 `mountpoint` 或 Linux 的 `/proc/self/mountinfo` 检查。

客户端通过已认证的 SSH 会话使用 SSHFS 的 passive 模式。它为当前会话分配临时挂载目录，断开时卸载。连接过程保留在用户权限内，开发依赖和测试服务由 Mac 运行。

弹窗管理一个项目及对应的 SSH 终端，关闭弹窗时断开。连接成功后保留项目与主机设置，SSH 密码只在连接时使用。文件服务只暴露所选目录，跳过环境文件、Git 元数据、`node_modules`、符号链接和硬链接。
