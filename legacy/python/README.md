# NWAFU 网上评教自动填写脚本

用于西北农林科技大学网上评教系统的自动填写脚本，自动勾选"完全赞同"选项并随机填写主观题评价。

## 功能特性

- 自动登录统一身份认证平台
- 自动处理验证码（需手动完成）
- 自动勾选所有单选题的"完全赞同"选项
- 自动填写主观题评价（随机从预设列表中选择）
- 图形界面设置评教内容和间隔时间

## 环境要求

- Python 3.8+
- Google Chrome 浏览器
- ChromeDriver（自动下载）

## 安装

1. 克隆或下载本项目

2. 创建虚拟环境并安装依赖：
   ```powershell
   python -m venv venv
   .\venv\Scripts\pip.exe install -r requirements.txt
   ```

3. 安装 Chrome 浏览器（如果尚未安装）

## 配置

### 方式一：环境变量（推荐）

创建 `.env` 文件配置账号信息（不会被 git 跟踪）：

```env
NWAFU_USERNAME=你的学号
NWAFU_PASSWORD=你的密码
NWAFU_TARGET_URL=评教页面地址
```

在 PowerShell 中加载环境变量：
```powershell
Get-Content .env | ForEach-Object { $name, $value = $_ -split '='; Set-Item "env:$name" $value }
```

### 方式二：手动输入

运行脚本时会弹出对话框提示输入学号、密码和评教地址。

## 使用

```powershell
.\venv\Scripts\python.exe main结果.py
```

### 使用流程

1. 运行脚本，自动填入学号密码并打开登录页面
2. 在浏览器中完成验证码验证
3. 验证成功后，按回车继续
4. 脚本自动进入评教页面并完成评教

## 项目结构

```
.
├── main结果.py          # 主程序入口
├── requirements.txt     # Python 依赖
├── .env                 # 环境变量配置（需手动创建）
├── .gitignore          # Git 忽略文件
└── README.md           # 本文件
```

## 依赖

- selenium>=4.0.0
- webdriver-manager>=4.0.0
- python-dotenv>=1.0.0

## 注意事项

- 请确保 Chrome 浏览器已安装且版本最新
- 验证码验证必须手动完成
- 建议首次使用时先测试一张评教
- 评教地址从评教系统页面获取

## 许可证

MIT License
