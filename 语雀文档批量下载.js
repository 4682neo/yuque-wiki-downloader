// ==UserScript==
// @name         语雀文档简易下载器 - 完整适配版
// @namespace    https://scriptcat.org/
// @version      1.0.0
// @description  点击按钮下载当前语雀文档为Markdown格式（支持所有文档类型，优化格式转换）
// @author       Aslan
// @match        https://www.yuque.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 获取CSRF Token
    function getCsrfToken() {
        const match = document.cookie.match(/yuque_ctoken=([^;]+)/);
        return match ? match[1] : '';
    }

    // 通用API请求函数
    async function yuqueApiRequest(url, options = {}) {
        const defaultOptions = {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': getCsrfToken()
            },
            credentials: 'include'
        };
        const response = await fetch(url, { ...defaultOptions, ...options });
        if (!response.ok) {
            throw new Error(`API请求失败: ${response.status}`);
        }
        return response.json();
    }

    // 从URL路径提取用户名和知识库slug
    function getUserAndBookFromUrl() {
        const pathMatch = window.location.pathname.match(/^\/([^\/]+)\/([^\/]+)(?:\/|$)/);
        if (pathMatch) {
            return { user: pathMatch[1], book: pathMatch[2] };
        }
        return null;
    }

    // 添加下载按钮
    function addDownloadButton() {
        if (document.getElementById('yuque-download-btn')) {
            return;
        }

        const button = document.createElement('button');
        button.id = 'yuque-download-btn';
        button.textContent = '下载为MD';
        button.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            z-index: 9999;
            padding: 10px 15px;
            background-color: #1890ff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            transition: all 0.3s;
        `;

        button.addEventListener('mouseenter', function() {
            this.style.backgroundColor = '#40a9ff';
            this.style.transform = 'translateY(-2px)';
        });

        button.addEventListener('mouseleave', function() {
            this.style.backgroundColor = '#1890ff';
            this.style.transform = 'translateY(0)';
        });

        button.addEventListener('click', handleDownload);

        document.body.appendChild(button);
    }

    // 处理下载
    async function handleDownload() {
        const button = document.getElementById('yuque-download-btn');
        const originalText = button.textContent;

        try {
            button.textContent = '加载中...';
            button.disabled = true;

            const currentUrl = window.location.href;
            const slugMatch = currentUrl.match(/yuque\.com\/[^\/]+\/[^\/]+\/([^\/?#]+)/);

            if (!slugMatch) {
                throw new Error('无法获取文档ID');
            }

            const slug = slugMatch[1];
            const docData = await getDocInfoBySlug(slug);

            if (!docData || !docData.content) {
                throw new Error('无法获取文档内容');
            }

            const markdown = convertToMarkdown(docData);
            downloadFile(markdown, `${docData.title}.md`);

            button.textContent = '下载成功';
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('下载失败:', error);
            button.textContent = '下载失败';
            setTimeout(() => {
                button.textContent = originalText;
                button.disabled = false;
            }, 2000);
        }
    }

    // 通过文档slug获取文档信息（用于获取book_id）- 融合版
    async function getDocInfoBySlug(slug) {
        // 最优先：从window.appData获取book_id（语雀页面全局变量）
        if (window.appData) {
            if (window.appData.book && window.appData.book.id) {
                const bookId = String(window.appData.book.id);
                console.log('从appData.book.id获取book_id:', bookId);
                const apiUrl = `https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&include_contributors=true&include_like=true&include_hits=true&merge_dynamic_data=false`;
                try {
                    const data = await yuqueApiRequest(apiUrl);
                    if (data.data && data.data.book_id) {
                        console.log('成功获取文档信息');
                        return data.data;
                    }
                } catch (e) {
                    console.log('appData方式获取失败:', e);
                }
            }
            if (window.appData.doc && window.appData.doc.book_id) {
                const bookId = String(window.appData.doc.book_id);
                console.log('从appData.doc.book_id获取book_id:', bookId);
                const apiUrl = `https://www.yuque.com/api/docs/${slug}?book_id=${bookId}&include_contributors=true&include_like=true&include_hits=true&merge_dynamic_data=false`;
                try {
                    const data = await yuqueApiRequest(apiUrl);
                    if (data.data && data.data.book_id) {
                        console.log('成功获取文档信息');
                        return data.data;
                    }
                } catch (e) {
                    console.log('appData.doc方式获取失败:', e);
                }
            }
        }
        
        const userBook = getUserAndBookFromUrl();
        
        // 尝试多种可能的book_id来源
        const possibleBookIds = [];
        
        // 从URL中提取可能的book_id
        const urlBookIdMatch = window.location.href.match(/book_id[=:]+(\d+)/i);
        if (urlBookIdMatch) {
            possibleBookIds.push(urlBookIdMatch[1]);
        }
        
        // 从页面script标签中提取book_id
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            if (script.textContent) {
                const patterns = [
                    /book_id\s*:\s*(\d+)/,
                    /"book_id"\s*:\s*(\d+)/,
                    /bookId\s*:\s*(\d+)/,
                    /"bookId"\s*:\s*(\d+)/
                ];
                for (const pattern of patterns) {
                    const match = script.textContent.match(pattern);
                    if (match) {
                        possibleBookIds.push(match[1]);
                    }
                }
            }
        }
        
        // 从localStorage提取
        try {
            const localBookId = localStorage.getItem('book_id');
            if (localBookId) {
                possibleBookIds.push(localBookId);
            }
        } catch (e) {
            // 忽略错误
        }
        
        // 构建API URL列表
        const urls = [];
        
        // 添加所有可能的book_id组合
        for (const bookId of possibleBookIds) {
            urls.push(`https://www.yuque.com/api/docs/${slug}?book_id=${bookId}`);
        }
        
        // 添加其他可能的API端点
        if (userBook) {
            urls.push(`https://www.yuque.com/api/docs/${slug}?book_id=1610235`);
            urls.push(`https://www.yuque.com/api/docs/${slug}?book_id=36939815`);
            urls.push(`https://www.yuque.com/api/docs/${slug}?book_id=63747238`);
        }
        urls.push(`https://www.yuque.com/api/mine/docs/${slug}`);
        
        // 去重
        const uniqueUrls = [...new Set(urls)];

        for (const apiUrl of uniqueUrls) {
            try {
                console.log('尝试API:', apiUrl);
                const data = await yuqueApiRequest(apiUrl);
                if (data.data && data.data.book_id) {
                    console.log('成功获取book_id:', data.data.book_id);
                    return data.data;
                }
            } catch (e) {
                console.log(`尝试API ${apiUrl} 失败:`, e);
            }
        }
        return null;
    }

    // HTML转Markdown - 使用DOM解析器
    function htmlToMarkdown(html) {
        // 移除Lake格式的DOCTYPE和meta标签
        html = html.replace(/<!doctype lake>/gi, '');
        html = html.replace(/<meta[^>]*>/gi, '');
        
        // 创建DOM解析器
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // 递归处理DOM节点
        return processNode(doc.body);
    }

    // 递归处理DOM节点
    function processNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const tagName = node.tagName.toLowerCase();
        let result = '';

        // 处理不同的标签
        switch (tagName) {
            case 'h1':
                result = '# ' + processChildren(node) + '\n\n';
                break;
            case 'h2':
                result = '## ' + processChildren(node) + '\n\n';
                break;
            case 'h3':
                result = '### ' + processChildren(node) + '\n\n';
                break;
            case 'h4':
                result = '#### ' + processChildren(node) + '\n\n';
                break;
            case 'h5':
                result = '##### ' + processChildren(node) + '\n\n';
                break;
            case 'h6':
                result = '###### ' + processChildren(node) + '\n\n';
                break;

            case 'p':
                const pContent = processChildren(node);
                if (pContent.trim()) {
                    result = pContent + '\n\n';
                }
                break;

            case 'blockquote':
                // 检查是否是语雀的提示框
                if (node.classList.contains('lake-alert')) {
                    const alertType = node.classList.contains('lake-alert-info') ? '💡' :
                                     node.classList.contains('lake-alert-warning') ? '⚠️' :
                                     node.classList.contains('lake-alert-success') ? '✅' : '📌';
                    const content = processChildren(node);
                    result = content.split('\n').map(line => `> ${alertType} ${line}`).join('\n') + '\n\n';
                } else {
                    const content = processChildren(node);
                    result = content.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
                }
                break;

            case 'ul':
            case 'ol':
                result = processList(node, tagName === 'ol' ? 1 : 0);
                break;

            case 'li':
                // 列表项在processList中处理
                result = processChildren(node);
                break;

            case 'strong':
            case 'b':
                result = '**' + processChildren(node) + '**';
                break;

            case 'em':
            case 'i':
                result = '*' + processChildren(node) + '*';
                break;

            case 'code':
                // 检查是否是代码块
                if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
                    result = processChildren(node);
                } else {
                    result = '`' + processChildren(node) + '`';
                }
                break;

            case 'pre':
                const codeContent = node.querySelector('code');
                const language = codeContent ? (codeContent.className.match(/language-(\w+)/) || [,''])[1] : '';
                const code = codeContent ? codeContent.textContent : node.textContent;
                result = '```' + language + '\n' + code + '\n```\n\n';
                break;

            case 'a':
                const href = node.getAttribute('href') || '';
                const text = processChildren(node);
                if (text.trim()) {
                    result = `[${text}](${href})`;
                }
                break;

            case 'img':
                const src = node.getAttribute('src') || '';
                const alt = node.getAttribute('alt') || '';
                result = `![${alt}](${src})\n\n`;
                break;

            case 'br':
                result = '\n';
                break;

            case 'hr':
                result = '\n---\n\n';
                break;

            case 'table':
                result = processTable(node);
                break;

            case 'thead':
            case 'tbody':
            case 'tr':
            case 'th':
            case 'td':
                // 表格元素在processTable中处理
                result = processChildren(node);
                break;

            case 'span':
                // span标签通常只是容器,直接处理子节点
                result = processChildren(node);
                break;

            case 'div':
                // div标签通常只是容器,直接处理子节点
                result = processChildren(node);
                break;

            case 'card':
                // 处理语雀特殊的card标签
                result = processYuqueCard(node);
                break;

            default:
                // 默认处理子节点
                result = processChildren(node);
        }

        return result;
    }

    // 处理子节点
    function processChildren(node) {
        let result = '';
        for (const child of node.childNodes) {
            result += processNode(child);
        }
        return result;
    }

    // 处理列表
    function processList(node, startNum = 0) {
        const items = node.querySelectorAll(':scope > li');
        let result = '';
        let counter = startNum;

        items.forEach(item => {
            const content = processChildren(item).trim();
            if (startNum > 0) {
                result += `${counter}. ${content}\n`;
                counter++;
            } else {
                result += `- ${content}\n`;
            }
        });

        return result + '\n';
    }

    // 处理表格
    function processTable(table) {
        const rows = table.querySelectorAll('tr');
        if (rows.length === 0) return '';

        let result = '';
        let isFirstRow = true;

        rows.forEach(row => {
            const cells = row.querySelectorAll('th, td');
            const cellContents = Array.from(cells).map(cell => processChildren(cell).trim());
            
            result += '| ' + cellContents.join(' | ') + ' |\n';
            
            // 添加表头分隔线
            if (isFirstRow) {
                result += '| ' + cellContents.map(() => '---').join(' | ') + ' |\n';
                isFirstRow = false;
            }
        });

        return result + '\n';
    }

    // 处理语雀特殊的card标签
    function processYuqueCard(node) {
        const name = node.getAttribute('name') || '';
        const value = node.getAttribute('value') || '';
        
        if (!value) {
            return '';
        }
        
        // 解码URL编码的value
        let decodedValue;
        try {
            decodedValue = decodeURIComponent(value);
        } catch (e) {
            return '';
        }
        
        // 提取data部分
        const dataMatch = decodedValue.match(/^data:(.+)$/);
        if (!dataMatch) {
            return '';
        }
        
        try {
            const cardData = JSON.parse(dataMatch[1]);
            
            // 处理不同类型的card
            switch (name) {
                case 'codeblock':
                    // 代码块
                    const code = cardData.code || '';
                    const mode = cardData.mode || '';
                    return '```' + mode + '\n' + code + '\n```\n\n';
                
                case 'image':
                    // 图片
                    const src = cardData.src || '';
                    const imgName = cardData.name || '';
                    return '![' + imgName + '](' + src + ')\n\n';
                
                case 'diagram':
                    // 图表（Mermaid等）
                    const diagramSrc = cardData.url || cardData.src || '';
                    const diagramType = cardData.type || 'mermaid';
                    return diagramSrc ? '![' + diagramType + '](' + diagramSrc + ')\n\n' : '';
                
                case 'localdoc':
                    // 附件
                    const docSrc = cardData.src || '';
                    const docName = cardData.name || '';
                    return '[' + docName + '](' + docSrc + ')\n\n';
                
                default:
                    return '';
            }
        } catch (e) {
            console.error('解析card数据失败:', e);
            return '';
        }
    }

    // 清理Markdown文本
    function cleanMarkdown(markdown) {
        // 移除多余的空行（保留最多两个连续空行）
        markdown = markdown.replace(/\n{3,}/g, '\n\n');
        
        // 移除行首行尾的空白字符
        markdown = markdown.split('\n').map(line => line.trimEnd()).join('\n');
        
        // 移除HTML实体
        markdown = markdown
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ');
        
        // 移除零宽字符
        markdown = markdown.replace(/[\u200B-\u200D\uFEFF]/g, '');
        
        // 移除特殊的零宽空格
        markdown = markdown.replace(/\u200B/g, '');
        
        return markdown.trim();
    }

    // 转换为Markdown
    function convertToMarkdown(docContent) {
        let markdown = `# ${docContent.title}\n\n`;

        // 处理内容
        if (docContent.content) {
            markdown += htmlToMarkdown(docContent.content);
        }

        // 最终清理
        return cleanMarkdown(markdown);
    }

    // 下载文件
    function downloadFile(content, filename) {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // 监听页面加载完成
    window.addEventListener('load', addDownloadButton);

    // 监听页面导航变化（单页应用）
    let lastUrl = location.href;
    new MutationObserver(() => {
        const currentUrl = location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            addDownloadButton();
        }
    }).observe(document, { subtree: true, childList: true });

})();
