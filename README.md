# Youtube - Auto Theater Mode Windowed Fullscreen Script

一个 Tampermonkey/Violentmonkey 用户脚本，用于自动将 YouTube 视频切换到影院模式，并调整播放器大小以实现窗口化全屏效果。

此脚本基于 GT-not-GD/Youtube-Windowed-Fullscreen 改进优化，在此进行改进与优化：

1. 不再自动点击进入影院模式
原脚本会用 checkAndEnterTheaterMode 反复重试、自动帮你点击影院模式按钮。现在完全移除了这部分逻辑,是否进入影院模式完全由你自己决定,脚本只是被动响应。
2. 搜索栏从"占用空间"变成"按需浮出"
原脚本只是让播放器高度 = innerHeight - masthead高度,搜索栏本身还老老实实待在原地占着一块地方。现在搜索栏默认用 translateY 收起、鼠标移到屏幕最顶部时才滑出,平时完全不挡视频。
3. 从源头消除了搜索栏的预留间距
原脚本的高度计算方式没意识到 page-manager 还有一段独立于搜索栏本身、通过 --ytd-masthead-height 这个 CSS 变量算出来的 margin-top。中间我们试过滚动补偿、负 margin-bottom 收缩可滚动高度等绕弯子的办法,最后定位到真正原因后,直接把这个变量在 page-manager 上归零,一行代码从根源解决,不需要任何滚动位移或高度补偿的 hack。
4. 严格限定作用范围为 /watch 页面
原脚本没有页面类型判断,只要 DOM 里找到了 masthead-container/full-bleed-container 就会应用样式,导致效果会"漏"到首页等其他页面。现在用 location.pathname === '/watch' 严格把关,并且在检测到离开 /watch 时无条件把所有样式彻底还原。
5. 用 YouTube 原生的 SPA 路由事件重构了触发时机
原脚本靠 MutationObserver 观察 body 子树变化来判断"页面是否加载完成",没有区分"跳转到新页面"和"页面内部小改动"。现在改用 yt-navigate-finish 事件,这是 YouTube 自己在每次 SPA 内部跳转完成后派发的事件,能准确捕捉"从首页点进视频""视频间跳转""退回首页"这几种场景,分别做正确的初始化或清理。
6. 能识别"已经处于影院模式"这个既有状态,而不仅仅是"状态变化的那一刻"
原脚本(以及本轮改造前几个版本)只在 default-layout 属性发生变化时才响应,导致刷新一个已经是影院模式的视频页、或者从首页直接点进一个默认打开就是影院模式的视频时,脚本不会生效,必须手动点一下按钮"激活"一次。现在 initWatchPage 会在元素就绪后主动读取当前真实状态并应用,不依赖"变化事件"。
7. 加了容错重试机制
原脚本假设关键元素在观察到 body 变化时就已经完整渲染好了。现在 initWatchPage 会在页面刚跳转过来、元素还没渲染完时自动重试(最多 30 次、间隔 150ms),更适应 SPA 场景下元素异步渲染的情况。
8. 统一的样式还原函数,避免样式残留
原脚本没有专门的"清理"逻辑,退出影院模式时的还原写得比较零散。现在抽出了 resetMastheadAndPlayerStyles(),在"手动退出影院模式"和"离开 /watch 页面"两种场景下统一调用,确保脚本产生的任何样式(定位、变换、CSS 变量覆盖)都不会遗留。
