// ==UserScript==
// @name         Youtube - Theater Mode Windowed Fullscreen
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  仅在视频详情页(/watch)生效：你手动进入影院模式后(或刷新/跳转进入时已经是影院模式)，直接把 page-manager 上的 --ytd-masthead-height 变量归零、从源头消除搜索栏预留间距，将播放器扩展为窗口化全屏，并让搜索栏默认收起、鼠标移到屏幕顶部时再滑出；离开视频页时自动还原，不影响首页等其他页面。Only active on watch pages (/watch): zeroes out the --ytd-masthead-height CSS variable on page-manager to eliminate the masthead's reserved spacing at the source (no scroll/margin workarounds needed), applies windowed fullscreen styling (including on refresh / SPA navigation directly into an already-theater-mode video), and auto-hides the masthead search bar (revealed on mouse-to-top). Fully restores everything when you navigate away, so it never affects the homepage or other pages.
// @author       GT
// @match        https://www.youtube.com/*
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @downloadURL  https://raw.githubusercontent.com/GT-not-GD/youtube-windowed-fullscreen/master/Youtube-Auto-Theater-Mode-Windowed-Fullscreen.user.js
// @updateURL    https://raw.githubusercontent.com/GT-not-GD/youtube-windowed-fullscreen/master/Youtube-Auto-Theater-Mode-Windowed-Fullscreen.user.js
// ==/UserScript==

// ... 脚本代码 ...

(function() {
    'use strict';

    // 存储找到的关键元素
    let ytdWatchFlexy = null;
    let mastheadContainer = null;
    let fullBleedContainer = null;
    // page-manager 的 margin-top 是通过 CSS 变量 --ytd-masthead-height 算出来的
    // （即之前发现的“预留间距”真正来源），直接覆盖这个变量比滚动/负 margin 更干净
    let pageManagerElement = null;

    // MutationObserver 实例：观察 default-layout 属性变化（即手动切换影院模式）
    let attributeObserver = null;
    // 用于在页面刚跳转到 /watch 时，等待关键元素渲染出来的重试定时器
    let initRetryTimeoutId = null;

    // 是否处于影院模式（用于控制“移开鼠标后收起搜索栏”的逻辑是否生效）
    let theaterModeActive = false;
    // 收起搜索栏的延时定时器
    let mastheadHideTimeoutId = null;

    // 鼠标距离顶部多少像素以内，视为“想要唤出搜索栏”
    const MASTHEAD_REVEAL_ZONE_PX = 48;
    // 鼠标移开顶部区域后，等待多久再收起搜索栏（避免鼠标稍微一抖就收起）
    const MASTHEAD_HIDE_DELAY_MS = 600;
    // 跳转到 /watch 后，等待关键元素渲染出来的最大重试次数 / 每次间隔
    const INIT_MAX_ATTEMPTS = 30;
    const INIT_RETRY_DELAY_MS = 150;

    // --- 工具函数：判断当前是否在视频详情页 ---
    // 严格按路径判断，只有 /watch 才生效，避免影响首页、搜索结果页、频道页等
    const isWatchPage = () => location.pathname === '/watch';

    // --- 工具函数：防抖 (Debounce) ---
    // 用于限制窗口 resize 事件的触发频率
    const debounce = (func, delay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    };

    // --- 搜索栏的“滑入/收起”辅助函数 ---
    // 收起：用 translateY 把它推出视口上方，不占地方也不挡视频
    const hideMasthead = () => {
        if (!mastheadContainer) return;
        mastheadContainer.style.setProperty("transform", "translateY(-100%)", "important");
    };

    // 唤出：滑回原位，盖在视频最上方，方便你点击搜索/头像等
    const showMasthead = () => {
        if (!mastheadContainer) return;
        mastheadContainer.style.setProperty("transform", "translateY(0)", "important");
    };

    // 鼠标移动时判断是否需要唤出/收起搜索栏（只在影院模式下生效）
    const handleMastheadMouseMove = (event) => {
        if (!theaterModeActive || !mastheadContainer) return;

        clearTimeout(mastheadHideTimeoutId);

        if (event.clientY <= MASTHEAD_REVEAL_ZONE_PX) {
            // 鼠标靠近顶部，立即唤出
            showMasthead();
        } else {
            // 鼠标离开顶部区域，延迟一小段时间后收起（避免频繁抖动）
            mastheadHideTimeoutId = setTimeout(hideMasthead, MASTHEAD_HIDE_DELAY_MS);
        }
    };

    // --- 还原函数：把搜索栏和播放器容器的样式全部还原成 YouTube 原本的样子 ---
    // 会在“退出影院模式”和“离开 /watch 页面”两种情况下调用，
    // 确保脚本产生的样式不会残留、更不会带到首页等其他页面。
    const resetMastheadAndPlayerStyles = () => {
        theaterModeActive = false;
        clearTimeout(mastheadHideTimeoutId);

        if (mastheadContainer) {
            mastheadContainer.style.removeProperty("position");
            mastheadContainer.style.removeProperty("top");
            mastheadContainer.style.removeProperty("left");
            mastheadContainer.style.removeProperty("right");
            mastheadContainer.style.removeProperty("z-index");
            mastheadContainer.style.removeProperty("transform");
            mastheadContainer.style.removeProperty("transition");
        }
        if (fullBleedContainer) {
            fullBleedContainer.style.removeProperty("min-height");
            fullBleedContainer.style.removeProperty("position");
        }
        // 还原 page-manager 上覆盖过的 --ytd-masthead-height 变量，让它的
        // margin-top 恢复由 YouTube 自己重新计算
        if (pageManagerElement) {
            pageManagerElement.style.removeProperty("--ytd-masthead-height");
        }
    };

    // --- 核心函数：应用影院模式样式 (搜索栏默认收起、靠近顶部才滑出 + 窗口化全屏) ---
    // 只要不在 /watch 页面，直接还原样式并退出——这是避免影响首页等其他页面的关键。
    // 在 /watch 页面时，本函数会读取当前真实的影院模式状态（不管是手动点击切换的，
    // 还是刷新/从首页跳转进来时页面本身就已经是影院模式），据此应用或还原样式。
    const applyTheaterStyles = () => {
        if (!isWatchPage()) {
            resetMastheadAndPlayerStyles();
            return;
        }

        // 在每次执行时尝试重新获取元素，以应对 YouTube SPA 页面元素的动态替换
        ytdWatchFlexy = document.getElementsByTagName("ytd-watch-flexy")[0];
        fullBleedContainer = document.getElementById("full-bleed-container");
        mastheadContainer = document.getElementById("masthead-container");
        pageManagerElement = document.getElementById("page-manager");

        // 检查所有必需的元素是否都已加载
        if (!ytdWatchFlexy || !fullBleedContainer || !mastheadContainer) {
            // console.log("YT Theater script: Elements not found yet for styling."); // 用于调试
            return; // 如果元素未找到，则退出，等待下次触发（初始化阶段由 initWatchPage 的重试机制兜底）
        }

        try {
            // 判断是否处于默认布局 (通过检查 default-layout 属性)
            // 这里读取的是元素上的“真实当前状态”，所以无论你是刚点了影院模式按钮，
            // 还是刷新页面/从首页点进来时视频本身就已经是影院模式，判断结果都准确。
            const defaultLayout = ytdWatchFlexy.hasAttribute("default-layout");

            // 如果处于默认布局（也就是当前不是影院模式），
            // 则把搜索栏和播放器容器都还原成 YouTube 原本的样子。
            if (defaultLayout) {
                // console.log("YT Theater script: Default layout detected, restoring masthead position.");
                resetMastheadAndPlayerStyles();
                return;
            }

            // 当前确实处于影院模式。
            // masthead-container 默认是 sticky 定位，而 sticky 在“已经贴顶”的状态下
            // 和 fixed 视觉上没有区别——都会一直悬浮盖在内容上方，且都不受滚动影响，
            // 所以单纯换成 fixed 并不能让它让开视频。
            // 这里改用“默认收起、鼠标靠近顶部才滑出”的方案：
            // fixed 定位脱离文档流，平时用 translateY 推出视口上方（不挡视频），
            // 鼠标移到屏幕最上方时再滑下来显示，方便随时点击搜索/头像等。
            mastheadContainer.style.setProperty("position", "fixed", "important");
            mastheadContainer.style.setProperty("top", "0", "important");
            mastheadContainer.style.setProperty("left", "0", "important");
            mastheadContainer.style.setProperty("right", "0", "important");
            mastheadContainer.style.setProperty("z-index", "9999", "important");
            mastheadContainer.style.setProperty("transition", "transform 0.2s ease", "important");

            theaterModeActive = true;
            // 初始状态收起，不遮挡视频；后续由 handleMastheadMouseMove 控制滑出/收起
            hideMasthead();

            // masthead 脱离文档流后不再占用布局空间，播放器区域可以直接铺满整个窗口高度
            const height = window.innerHeight;

            // 应用样式到视频容器
            // 使用 !important 可能会增加覆盖其他样式成功的几率
            fullBleedContainer.style.setProperty("min-height", height + "px", "important");
            // 在非默认布局下通常使用 relative 或 absolute，relative 较常见且不脱离文档流
            fullBleedContainer.style.setProperty("position", "relative");

            // 之前排查发现：真正留出这段空白的，是 page-manager 自己的 margin-top，
            // 它是通过 CSS 变量 var(--ytd-masthead-height, var(--ytd-toolbar-height)) 算出来的
            // （默认 56px），专门用来在正常状态下给吸顶的搜索栏腾地方。
            // 直接把这个变量在 page-manager 上覆盖成 0，浏览器会原生重新计算布局，
            // margin-top 自动归零，视频从最顶部开始渲染——不需要再手动滚动或者
            // 用负 margin 去补偿可滚动高度，从源头上解决，而不是事后补救。
            if (pageManagerElement) {
                pageManagerElement.style.setProperty("--ytd-masthead-height", "0px", "important");
            }

            // console.log(`YT Theater script: Applied styles: min-height=${height}px, position=relative, masthead auto-hide enabled, page-manager margin cleared`); // 用于调试

        } catch (error) {
            console.error("YT Theater script: Error applying styles:", error);
        }
    };

    // 创建一个防抖版本的样式应用函数，用于 resize 事件
    const debouncedApplyStyles = debounce(applyTheaterStyles, 100); // 100ms 防抖延迟

    // --- 监听器和观察者设置 ---

    // MutationObserver 用于监听 ytd-watch-flexy 元素的属性变化
    // 主要用于检测 default-layout 属性的变化 (即你手动切换影院模式的时刻)
    const setupAttributeObserver = () => {
        if (!ytdWatchFlexy) {
             // console.log("YT Theater script: ytd-watch-flexy not found for attribute observer setup."); // Debug
             return; // 确保 ytdWatchFlexy 元素已找到
        }

        // 如果观察者已存在，先断开连接以避免重复
        if (attributeObserver) attributeObserver.disconnect();

        attributeObserver = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                // 只关心 attributes 类型的变化，并且只关心 default-layout 属性
                if (mutation.type === 'attributes' && mutation.attributeName === 'default-layout') {
                    // console.log(`YT Theater script: default-layout attribute changed. New value: ${ytdWatchFlexy.hasAttribute('default-layout')}`); // 用于调试

                    // default-layout 属性的变化只可能来自你手动点击了影院模式按钮
                    // (或者退出影院模式)。无论哪种情况，只需重新应用/还原样式即可
                    // (进入影院模式 → 搜索栏默认收起、播放器铺满窗口；退出 → 还原搜索栏和容器样式)，
                    // 不再主动尝试点击任何按钮。
                    applyTheaterStyles();
                }
            });
        });

        // 开始观察 ytdWatchFlexy 元素的属性变化
        attributeObserver.observe(ytdWatchFlexy, {
            attributes: true, // 观察属性变化
            attributeFilter: ['default-layout'] // 只关心 default-layout 属性
        });

        // console.log("YT Theater script: Attribute observer set up on ytd-watch-flexy."); // 用于调试
    };

    // --- 初始化 /watch 页面：等待关键元素渲染出来，再应用当前真实的影院模式状态 ---
    // 无论你是刷新一个已经是影院模式的视频页，还是从首页点进一个视频（不管它
    // 打开时是不是影院模式），这个函数都会读取页面此刻的真实状态并正确应用。
    const initWatchPage = (attemptsLeft = INIT_MAX_ATTEMPTS) => {
        clearTimeout(initRetryTimeoutId);

        // 跳转途中用户可能又离开了 /watch，这里再确认一次，避免多余的操作
        if (!isWatchPage()) {
            return;
        }

        ytdWatchFlexy = document.getElementsByTagName("ytd-watch-flexy")[0];
        mastheadContainer = document.getElementById("masthead-container");
        fullBleedContainer = document.getElementById("full-bleed-container");
        pageManagerElement = document.getElementById("page-manager");

        if (!ytdWatchFlexy || !mastheadContainer || !fullBleedContainer) {
            // 页面刚跳转过来，关键元素可能还没渲染完，稍后重试（有次数上限，避免无限重试）
            if (attemptsLeft > 0) {
                initRetryTimeoutId = setTimeout(() => initWatchPage(attemptsLeft - 1), INIT_RETRY_DELAY_MS);
            }
            return;
        }

        // 元素已就绪：根据当前真实的 default-layout 状态应用/还原样式
        applyTheaterStyles();
        // 重新绑定属性观察者到这个（可能是新的）ytd-watch-flexy 实例上
        setupAttributeObserver();

        // console.log("YT Theater script: Watch page initialized."); // 用于调试
    };

    // --- 路由变化处理：进入 /watch 时初始化，离开 /watch 时彻底清理 ---
    const handleRouteChange = () => {
        clearTimeout(initRetryTimeoutId);

        if (isWatchPage()) {
            initWatchPage();
        } else {
            // 离开视频详情页（比如回到首页）：断开属性观察者、
            // 并把之前可能应用过的搜索栏/播放器样式彻底还原，
            // 这样脚本产生的效果绝不会带到首页等其他页面。
            if (attributeObserver) {
                attributeObserver.disconnect();
                attributeObserver = null;
            }
            resetMastheadAndPlayerStyles();
        }
    };

    // --- 脚本开始执行 ---

    // YouTube 是 SPA，页面间跳转不会触发浏览器的整页刷新，
    // 而是会在跳转完成后派发 yt-navigate-finish 事件，这是判断路由变化最可靠的方式。
    document.addEventListener('yt-navigate-finish', handleRouteChange);

    // 监听窗口大小改变事件，并使用防抖处理（内部的 applyTheaterStyles 已经会
    // 自动判断是否在 /watch 页面，非 /watch 页面下不会做任何事）
    window.addEventListener('resize', debouncedApplyStyles);

    // 监听鼠标移动，用于控制影院模式下搜索栏的滑出/收起
    // (handleMastheadMouseMove 内部会检查 theaterModeActive，非影院模式/非 /watch 页面下直接跳过)
    window.addEventListener('mousemove', handleMastheadMouseMove);

    // 脚本注入时立即处理一次当前路由：
    // - 如果是刷新页面直接停在 /watch（不管是不是已经是影院模式），会正确初始化；
    // - 如果脚本注入时你在首页等其他页面，则什么都不做，等 yt-navigate-finish 触发。
    handleRouteChange();

})(); // 使用立即执行函数表达式 (IIFE) 包裹代码，防止变量污染全局作用域
