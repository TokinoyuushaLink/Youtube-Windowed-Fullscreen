// ==UserScript==
// @name         Youtube - Theater Mode Windowed Fullscreen
// @namespace    http://tampermonkey.net/
// @version      5.7
// @description  Youtube - Auto Enter Theater Mode and Windowed Fullscreen. YT自动进入影院模式并窗口化全屏.
// @author       GT / TokinoyuushaLink
// @match        https://www.youtube.com/*
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @downloadURL  https://github.com/TokinoyuushaLink/Youtube-Windowed-Fullscreen/raw/refs/heads/main/Youtube-Auto-Theater-Mode-Windowed-Fullscreen.user.js
// @updateURL    https://github.com/TokinoyuushaLink/Youtube-Windowed-Fullscreen/raw/refs/heads/main/Youtube-Auto-Theater-Mode-Windowed-Fullscreen.user.js
// ==/UserScript==


(function() {
    'use strict';

    // 存储找到的关键元素
    let ytdWatchFlexy = null;
    let mastheadContainer = null;
    let fullBleedContainer = null;
    let pageManagerElement = null;

    let attributeObserver = null;
    let initRetryTimeoutId = null;

    let theaterModeActive = false;

    // --- IntersectionObserver 相关状态（本版本核心） ---
    let scrollSentinel = null;
    let scrollRevealObserver = null;
    // 当前搜索栏是否处于“已显示”状态；null 表示还没做过真实判断，
    // 保证每次重新挂载 observer 后，第一次回调一定会真正生效一次
    let mastheadRevealed = null;

    // --- 搜索栏配色相关状态（第二个 observer）---
    // 只在“站点本身是浅色主题”时才需要干预：播放器区域是黑色背景，
    // 搜索栏悬浮其上时保持深色是对的；只有滚过播放器、进入浅色的评论区背景后，
    // 才需要把搜索栏也切成浅色。站点本身是深色主题时全程都是黑色，不需要干预。
    let themeSentinel = null;
    let mastheadThemeObserver = null;

    // “判定为顶部”的缓冲距离（像素）
    const SENTINEL_THRESHOLD_PX = 48;
    const INIT_MAX_ATTEMPTS = 30;
    const INIT_RETRY_DELAY_MS = 150;

    // 配色切换动画时长
    const THEME_TRANSITION_MS = 250;
    const THEME_TRANSITION_STYLE_ID = 'yt-theater-masthead-theme-transition-style';

    // 给 ytd-masthead（真正切换 dark 属性、颜色跟着变化的元素）及其所有子元素
    // 加一段 transition：dark 属性切换、内部颜色变量跟着变的时候，浏览器会自动
    // 在新旧颜色之间过渡，而不是瞬间跳变。只需要注入一次，用 id 做幂等判断。
    // 用 !important 是为了盖过 YouTube 自己可能设置的 transition: none。
    const injectThemeTransitionStyle = () => {
        if (document.getElementById(THEME_TRANSITION_STYLE_ID)) {
            return;
        }
        const styleEl = document.createElement('style');
        styleEl.id = THEME_TRANSITION_STYLE_ID;
        styleEl.textContent = `
            #masthead,
            #masthead * {
                transition: background-color ${THEME_TRANSITION_MS}ms ease,
                            color ${THEME_TRANSITION_MS}ms ease,
                            fill ${THEME_TRANSITION_MS}ms ease,
                            stroke ${THEME_TRANSITION_MS}ms ease,
                            border-color ${THEME_TRANSITION_MS}ms ease !important;
            }
        `;
        document.head.appendChild(styleEl);
    };

    const removeThemeTransitionStyle = () => {
        const styleEl = document.getElementById(THEME_TRANSITION_STYLE_ID);
        if (styleEl && styleEl.parentNode) {
            styleEl.parentNode.removeChild(styleEl);
        }
    };

    // 站点本身是否是浅色主题：YouTube 用 <html dark> 这个属性标记深色主题
    const isSiteLightTheme = () => !document.documentElement.hasAttribute('dark');

    const isWatchPage = () => location.pathname === '/watch';

    const debounce = (func, delay) => {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    };

    const hideMasthead = () => {
        if (!mastheadContainer) return;
        mastheadContainer.style.setProperty("transform", "translateY(-100%)", "important");
    };

    const showMasthead = () => {
        if (!mastheadContainer) return;
        mastheadContainer.style.setProperty("transform", "translateY(0)", "important");
    };

    // 复用同一个哨兵节点，避免每次进入影院模式都重新创建 DOM 元素
    const ensureScrollSentinel = () => {
        if (scrollSentinel && scrollSentinel.isConnected) {
            return scrollSentinel;
        }
        const sentinel = document.createElement('div');
        sentinel.id = 'yt-theater-scroll-sentinel';
        // 宽度设为 0（而不是之前的 1px）：这个哨兵只是用来判断纵向滚动位置，
        // 横向尺寸完全不重要，但因为它是普通文档流里的元素、插在 page-manager
        // 第一个子元素位置，1px 的宽度会挤压 page-manager 的横向布局（大概率是
        // flex），导致播放器宽度计算偏差 1px，露出容器背景色的一条细边。
        // 宽度归零后就不会再占用任何横向空间了。
        sentinel.style.cssText = 'width:0;height:1px;margin:0;padding:0;pointer-events:none;opacity:0;';
        if (pageManagerElement) {
            pageManagerElement.insertBefore(sentinel, pageManagerElement.firstChild);
        }
        scrollSentinel = sentinel;
        return sentinel;
    };

    const setupScrollRevealObserver = () => {
        if (scrollRevealObserver || !pageManagerElement) return;

        mastheadRevealed = null; // 强制下一次回调一定会真正生效
        const sentinel = ensureScrollSentinel();

        scrollRevealObserver = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;

            // 哨兵在缓冲区内 = 还在顶部附近 = 应该隐藏；反之应该显示
            const shouldReveal = !entry.isIntersecting;

            // 状态没有变化就跳过，避免重复写同一个样式
            if (shouldReveal === mastheadRevealed) return;
            mastheadRevealed = shouldReveal;

            if (shouldReveal) {
                showMasthead();
            } else {
                hideMasthead();
            }
        }, {
            root: null,
            rootMargin: `${SENTINEL_THRESHOLD_PX}px 0px 0px 0px`,
            threshold: 0
        });
        scrollRevealObserver.observe(sentinel);
    };

    const teardownScrollRevealObserver = () => {
        if (scrollRevealObserver) {
            scrollRevealObserver.disconnect();
            scrollRevealObserver = null;
        }
        if (scrollSentinel && scrollSentinel.parentNode) {
            scrollSentinel.parentNode.removeChild(scrollSentinel);
        }
        scrollSentinel = null;
        mastheadRevealed = null;
    };

    // --- 第二个 observer：搜索栏配色跟随滚动位置切换 ---
    // 哨兵插在 full-bleed-container（播放器容器，已经是 position:relative）内部，
    // 用 position:absolute + bottom 精确定位在“播放器高度 - 搜索栏高度”这个临界点上：
    // 哨兵还在视口内可见 = 还没滚过播放器 = 保持深色；
    // 哨兵被滚出视口上方 = 已经滚过播放器进入浅色内容区 = 切成浅色。
    // 每次调用都会重新定位哨兵（而不是只在创建时定位一次），
    // 这样 resize 导致播放器高度变化时，临界点也会跟着更新。
    const ensureThemeSentinel = () => {
        if (!fullBleedContainer) return null;

        if (!themeSentinel || !themeSentinel.isConnected) {
            const sentinel = document.createElement('div');
            sentinel.id = 'yt-theater-theme-sentinel';
            // 绝对定位、1px×1px、完全透明，不参与视觉呈现，只作为交叉检测的几何锚点
            sentinel.style.cssText = 'position:absolute;left:0;width:1px;height:1px;margin:0;padding:0;pointer-events:none;opacity:0;';
            fullBleedContainer.appendChild(sentinel);
            themeSentinel = sentinel;
        }

        // 每次都重新计算并写入 bottom，保证临界点位置始终等于
        // “播放器高度 - 当前搜索栏高度”
        let mastheadHeight = mastheadContainer
            ? parseFloat(window.getComputedStyle(mastheadContainer).getPropertyValue("height"))
            : 0;
        if (isNaN(mastheadHeight)) {
            mastheadHeight = 0;
        }
        themeSentinel.style.bottom = `${mastheadHeight}px`;

        return themeSentinel;
    };

    const setupMastheadThemeObserver = () => {
        // 只在浅色主题下才需要这套逻辑：深色主题全程都是黑色背景，
        // 保持 YouTube 原生行为（进入影院模式即深色）就是对的，不需要干预。
        if (!isSiteLightTheme()) {
            return;
        }

        // 注入过渡动画样式，让 dark 属性切换时颜色平滑过渡而不是瞬间跳变
        injectThemeTransitionStyle();

        const sentinel = ensureThemeSentinel();
        if (!sentinel) return;

        if (mastheadThemeObserver) {
            // 已存在的 observer 只是重新定位了哨兵，不需要重建
            return;
        }

        mastheadThemeObserver = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;

            const mastheadElement = document.getElementById('masthead');
            if (!mastheadElement) return;

            if (entry.isIntersecting) {
                // 还没滚过播放器：保持/恢复深色，贴合黑色播放器背景
                mastheadElement.setAttribute('dark', '');
            } else {
                // 已经滚过播放器，进入浅色内容区：切成浅色
                mastheadElement.removeAttribute('dark');
            }
        }, {
            root: null,
            threshold: 0
        });
        mastheadThemeObserver.observe(sentinel);
    };

    const teardownMastheadThemeObserver = () => {
        if (mastheadThemeObserver) {
            mastheadThemeObserver.disconnect();
            mastheadThemeObserver = null;
        }
        if (themeSentinel && themeSentinel.parentNode) {
            themeSentinel.parentNode.removeChild(themeSentinel);
        }
        themeSentinel = null;
        removeThemeTransitionStyle();
    };

    const resetMastheadAndPlayerStyles = () => {
        theaterModeActive = false;
        teardownScrollRevealObserver();
        teardownMastheadThemeObserver();

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
        if (pageManagerElement) {
            pageManagerElement.style.removeProperty("--ytd-masthead-height");
        }
    };

    const applyTheaterStyles = () => {
        if (!isWatchPage()) {
            resetMastheadAndPlayerStyles();
            return;
        }

        ytdWatchFlexy = document.getElementsByTagName("ytd-watch-flexy")[0];
        fullBleedContainer = document.getElementById("full-bleed-container");
        mastheadContainer = document.getElementById("masthead-container");
        pageManagerElement = document.getElementById("page-manager");

        if (!ytdWatchFlexy || !fullBleedContainer || !mastheadContainer) {
            return;
        }

        try {
            const defaultLayout = ytdWatchFlexy.hasAttribute("default-layout");

            if (defaultLayout) {
                resetMastheadAndPlayerStyles();
                return;
            }

            mastheadContainer.style.setProperty("position", "fixed", "important");
            mastheadContainer.style.setProperty("top", "0", "important");
            mastheadContainer.style.setProperty("left", "0", "important");
            mastheadContainer.style.setProperty("right", "0", "important");
            mastheadContainer.style.setProperty("z-index", "9999", "important");
            mastheadContainer.style.setProperty("transition", "transform 0.15s ease", "important");

            theaterModeActive = true;
            hideMasthead();
            setupScrollRevealObserver();

            const height = window.innerHeight;
            fullBleedContainer.style.setProperty("min-height", height + "px", "important");
            fullBleedContainer.style.setProperty("position", "relative");

            if (pageManagerElement) {
                pageManagerElement.style.setProperty("--ytd-masthead-height", "0px", "important");
            }

            // 播放器区域背景是黑色的，搜索栏悬浮其上时保持深色（YouTube 原生行为）
            // 是对的；只有滚过播放器、进入浅色的评论区背景后，才需要把搜索栏也
            // 切成浅色，而且只在站点本身是浅色主题时才需要这样做——深色主题下
            // 全程都是黑色背景，保持原生行为即可，不用管。
            // 依赖 fullBleedContainer 已经是 position:relative（上面已设置），
            // 所以放在这之后调用。
            setupMastheadThemeObserver();

        } catch (error) {
            console.error("YT Theater script (observer): Error applying styles:", error);
        }
    };

    const debouncedApplyStyles = debounce(applyTheaterStyles, 100);

    const setupAttributeObserver = () => {
        if (!ytdWatchFlexy) return;
        if (attributeObserver) attributeObserver.disconnect();

        attributeObserver = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'default-layout') {
                    applyTheaterStyles();
                }
            });
        });

        attributeObserver.observe(ytdWatchFlexy, {
            attributes: true,
            attributeFilter: ['default-layout']
        });
    };

    const initWatchPage = (attemptsLeft = INIT_MAX_ATTEMPTS) => {
        clearTimeout(initRetryTimeoutId);

        if (!isWatchPage()) {
            return;
        }

        ytdWatchFlexy = document.getElementsByTagName("ytd-watch-flexy")[0];
        mastheadContainer = document.getElementById("masthead-container");
        fullBleedContainer = document.getElementById("full-bleed-container");
        pageManagerElement = document.getElementById("page-manager");

        if (!ytdWatchFlexy || !mastheadContainer || !fullBleedContainer) {
            if (attemptsLeft > 0) {
                initRetryTimeoutId = setTimeout(() => initWatchPage(attemptsLeft - 1), INIT_RETRY_DELAY_MS);
            }
            return;
        }

        applyTheaterStyles();
        setupAttributeObserver();
    };

    const handleRouteChange = () => {
        clearTimeout(initRetryTimeoutId);

        if (isWatchPage()) {
            initWatchPage();
        } else {
            if (attributeObserver) {
                attributeObserver.disconnect();
                attributeObserver = null;
            }
            resetMastheadAndPlayerStyles();
        }
    };

    document.addEventListener('yt-navigate-finish', handleRouteChange);
    window.addEventListener('resize', debouncedApplyStyles);

    handleRouteChange();

})();
