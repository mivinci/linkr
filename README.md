# Linkr 求解器

给 [Linkr](https://www.playlinkr.net/)（也就是数连 / Numberlink）的截图自动求解 —— 把图丢进去，识别点边结构，算出答案。

在线：<https://le0.me/linkr/>

## 用法

把游戏截图拖进页面（或点「打开截图」），识别结果会叠在图上：黄圈是点、绿线是边、彩色圈是成对的端点。

- 识别有偏差就用「加点 / 删点边 / 连边 / 设颜色」修一下
- 「求解」出答案；勾「顺便求唯一解」会再跑一遍穷举确认
- 「算法演示」能把求解器**在这一道题上真实的生长过程**逐步放出来
- 「导出图片」导出裁剪到棋盘范围的答案图；也可以用单文件版 <https://le0.me/linkr/linkr-solver.html>

## 它是怎么解的

所有颜色**同时**从各自的端点出发生长，每一步只扩展「当前可走分支最少」的那个头。每走一步做四道剪枝：端点独占、度数下限、可达性、连通块。第一轮没出解就**打乱颜色的编号**重来 —— 搜索树的形状几乎只受颜色编号顺序影响，跟顶点编号、走子顺序都没关系。

详见界面里的「算法演示」，以及 `python/` 下的参考实现。

## 开发

```bash
npm install
npm run dev            # 开发
npm run build          # 类型检查 + 构建到 dist/
npm run build:single   # 额外产出单文件 linkr-solver.html
npm test               # 求解器单元测试
```

`python/` 是 uv 管理的命令行版，用来做跨语言对照：

```bash
cd python && uv run python demo.py <截图>
```

推到 `main` 会触发 GitHub Actions 部署到 Pages。
