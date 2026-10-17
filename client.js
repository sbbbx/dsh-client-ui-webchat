// DeepSeek web chat panel — browser half.
//
// Why the panel owns a resident guest instead of mounting the <webview> inside
// React: switching panels unmounts the page, and the desktop shell hands out an
// attach-once lease per element. One element, created once, docked to whatever
// rectangle the panel currently occupies. Leaving the panel only hides it, so
// the chat (and the login) survives a round trip through the conversation view
// and, thanks to the persisted partition, an app restart.
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-webchat',
  factory(require) {
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const PANEL_ID = 'webchat';
    const PANEL_ORDER = 30;
    /** Sentinel option in the session picker that asks for a brand-new Session. */
    const NEW_SESSION = '\u0000new';
    const WEB_URL = 'https://chat.deepseek.com';
    // Fixed key: the shell maps it to one partition, so signing in once covers
    // every later mount. `persist:` partitions keep cookies across restarts.
    const LEASE_KEY = 'webchat';

    /** Read an exact button/`surface` token, falling back to a neutral grey. */
    const BTN = {
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
      background: 'var(--dsw-alias-bg-layer-2, #f4f4f5)',
      color: 'var(--dsw-alias-label-primary, #111)',
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    };
    const CAPTION = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' };

    function newId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch {}
      return 'webchat-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
    }

    function zone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    }

    // ---------------------------------------------------------------------
    // Capture: runs inside chat.deepseek.com, so it may use DOM APIs freely.
    // ---------------------------------------------------------------------
    async function guestOp(action, arg) {
      const FENCE = '```';      const plain = (node) => (node && node.innerText ? node.innerText : '').trim();

      const markdown = (root) => {
        const out = [];
        const walk = (node) => {
          if (node.nodeType === 3) {
            out.push(node.textContent);
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName;
          if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return;
          // Web-search citation chips: a bare "-5"/"[5]" leaf, or a numbered
          // superscript. Real prose never puts a lone signed number in its own
          // element, so dropping these loses nothing and keeps the quote clean.
          const chip = (node.textContent || '').trim();
          if (/^-\s?\d{1,3}$/.test(chip) || /^\[\d{1,3}\]$/.test(chip)) return;
          if ((tag === 'SUP' || tag === 'SUB') && /^\d{1,3}$/.test(chip)) return;
          if (tag === 'LI' && /^\d{1,3}$/.test(chip)) return;
          if (tag === 'PRE') {
            out.push('\n' + FENCE + '\n' + plain(node) + '\n' + FENCE + '\n');
            return;
          }
          if (tag === 'CODE') {
            out.push('`' + plain(node) + '`');
            return;
          }
          if (/^H[1-6]$/.test(tag)) {
            out.push('\n' + '#'.repeat(Number(tag[1])) + ' ' + plain(node) + '\n');
            return;
          }
          if (tag === 'LI') {
            out.push('\n- ' + plain(node));
            return;
          }
          if (tag === 'BR') {
            out.push('\n');
            return;
          }
          if (tag === 'P' || tag === 'DIV' || tag === 'UL' || tag === 'OL' || tag === 'TABLE' || tag === 'TR') out.push('\n');
          for (const child of node.childNodes) walk(child);
          if (tag === 'TD' || tag === 'TH') out.push(' | ');
        };
        walk(root);
        return out
          .join('')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };

      // Assistant content is anything carrying a markdown/thinking block. A user
      // bubble never does; a search card or a thinking panel always does. That
      // distinction is what stops "搜索到 23 个网页" from being read as the
      // question — it sits inside the reply, not above it.
      const looksAssistant = (node) => {
        if (!node || typeof node.querySelector !== 'function') return false;
        return Boolean(node.querySelector('.ds-markdown, .ds-markdown--block, .ds-think-content, [class*="think"]'));
      };

      const questionOf = (node) => {
        let cursor = node;
        for (let hop = 0; hop < 8 && cursor; hop += 1) {
          const group = cursor.parentElement;
          if (!group) break;
          const sibling = group.previousElementSibling;
          if (sibling && !looksAssistant(sibling)) {
            const candidate = plain(sibling).replace(/\s*\n+\s*/g, ' ');
            if (candidate.length >= 2 && candidate.length <= 2000) return candidate;
          }
          cursor = group;
        }
        return '';
      };

      // The thinking text is rendered with the same `.ds-markdown` class as the
      // answer, so the answer must be selected semantically: the answer body is
      // `.ds-assistant-message-main-content`, and anything inside a thinking or
      // collapsible area is process text, not a reply.
      const inProcess = (node) => {
        try {
          return Boolean(node.closest && node.closest('.ds-think-content, [class*="think"], [class*="collapsible"]'));
        } catch {
          return false;
        }
      };

      const blocks = () => {
        const main = Array.prototype.slice.call(document.querySelectorAll('.ds-assistant-message-main-content'));
        const raw =
          main.length > 0
            ? main
            : Array.prototype.slice
                .call(document.querySelectorAll('.ds-markdown, .ds-markdown--block, [class*="markdown"]'))
                .filter((node) => !inProcess(node));
        return raw
          .filter((node) => plain(node).length > 0)
          // Nested matches (a markdown wrapper inside a markdown body) would split
          // one reply into several rounds.
          .filter((node) => !raw.some((other) => other !== node && other.contains(node)));
      };

      // One round = one user question plus everything the assistant rendered for
      // it (thinking, search cards, the answer). Consecutive blocks resolving to
      // the same question are the same round, and the last one is the answer, so
      // it wins. Blocks without a question are never merged.
      const roundsOf = () => {
        const rounds = [];
        for (const node of blocks()) {
          const question = questionOf(node);
          const previous = rounds.length > 0 ? rounds[rounds.length - 1] : null;
          if (previous && question && previous.question === question) {
            previous.node = node;
            previous.len = plain(node).length;
            continue;
          }
          rounds.push({ node: node, question: question, len: plain(node).length });
        }
        return rounds;
      };

      if (action === 'chats') {
        const seen = new Set();
        const chats = [];
        const links = document.querySelectorAll('a[href*="/a/chat/"], a[href*="/chat/s/"]');
        for (const link of links) {
          const href = link.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const label = plain(link)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 40);
          chats.push({ href: href, label: label || href.slice(-12) });
          if (chats.length >= 200) break;
        }
        return { chats: chats, current: location.href };
      }

      const rounds = roundsOf();
      if (action === 'rounds') {
        return {
          rounds: rounds.map((item, index) => {
            const head = item.question
              ? item.question.slice(0, 24) + (item.question.length > 24 ? '…' : '')
              : '无提问（纯回答）';
            return { label: '第 ' + (index + 1) + ' 轮 · ' + head + ' · ' + item.len + ' 字', len: item.len };
          }),
        };
      }

      const index = typeof arg === 'number' && arg >= 0 ? Math.min(arg, rounds.length - 1) : rounds.length - 1;
      const turn = rounds[index] || null;
      const answer = turn ? turn.node : null;

      // Generation guard: sample the answer twice. Changing text means the page
      // is still streaming, and a half answer is worse than none. Selector-free
      // on purpose: DeepSeek's stop button markup is build-randomized.
      if (answer) {
        const before = plain(answer);
        await new Promise((resolve) => setTimeout(resolve, 450));
        if (plain(answer) !== before) return { generating: true, text: '' };
      }

      let body = answer ? markdown(answer) : '';
      if (!body) {
        const pres = document.querySelectorAll('pre');
        if (pres.length > 0) body = FENCE + '\n' + plain(pres[pres.length - 1]) + '\n' + FENCE;
      }
      if (!body) body = String(window.getSelection ? window.getSelection() : '').trim();
      if (!body) return { generating: false, text: '' };

      // The round already carries its question; the agent gets the context the
      // answer alone is missing.
      const question = turn ? turn.question : '';

      return {
        generating: false,
        text: question ? '> 我（网页版）问：' + question + '\n\n' + body : body,
      };
    }

    // ---------------------------------------------------------------------
    // Reverse handoff: write text into the page's composer. Runs inside
    // chat.deepseek.com. It never sends — the user reviews, then presses send.
    // ---------------------------------------------------------------------
    function fillGuest(text) {
      const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));
      const areas = Array.from(document.querySelectorAll('textarea')).filter((el) => !el.disabled && !el.readOnly);
      const area = areas.length ? areas[areas.length - 1] : null;
      if (area) {
        // React tracks the value setter, so a plain assignment is ignored.
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(area, text);
        fire(area);
        area.focus();
        return { ok: true, mode: 'textarea', length: area.value.length };
      }
      const box = document.querySelector('[contenteditable="true"]');
      if (box) {
        box.focus();
        let done = false;
        try {
          done = document.execCommand('insertText', false, text);
        } catch {}
        if (!done) {
          box.textContent = text;
          fire(box);
        }
        return { ok: true, mode: 'editable', length: (box.textContent || '').length };
      }
      return { ok: false, mode: 'none', length: 0 };
    }

    // ---------------------------------------------------------------------
    // Resident guest managed outside React.
    // ---------------------------------------------------------------------
    const guest = { promise: null, wrapper: null, webview: null };

    function ensureGuest() {
      if (guest.promise) return guest.promise;
      guest.promise = (async () => {
        const bridge = window.dshDesktop && window.dshDesktop.browser;
        if (!bridge || typeof bridge.acquire !== 'function') {
          throw new Error('这个面板只能在 DSH 桌面端里使用');
        }
        const reservation = await bridge.acquire(LEASE_KEY);
        if (!reservation || typeof reservation.lease !== 'string') {
          throw new Error('桌面端拒绝了内嵌浏览器请求');
        }

        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
          position: 'fixed',
          left: '0px',
          top: '0px',
          width: '0px',
          height: '0px',
          display: 'none',
          zIndex: '20',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
        });

        const view = document.createElement('webview');
        view.setAttribute('name', reservation.lease);
        view.setAttribute('partition', reservation.partition || '');
        view.setAttribute('allowpopups', '');
        // The shell only accepts a guest whose URL still reads about:blank#<lease>.
        view.setAttribute('src', 'about:blank#' + reservation.lease);
        Object.assign(view.style, { width: '100%', height: '100%', display: 'block', border: '0px' });

        let navigated = false;
        view.addEventListener('dom-ready', () => {
          if (navigated) return;
          navigated = true;
          // Same event the shell uses to bind the lease, so navigate a beat later.
          setTimeout(() => {
            try {
              view.setAttribute('src', WEB_URL);
            } catch {}
            // A fresh guest often starts at its 150px default; make it re-measure.
            setTimeout(() => {
              guest.appliedHeight = -1;
              nudgeGuest();
            }, 120);
          }, 60);
        });

        // ponytail: a link the page opens is dropped in v0 (no second guest).
        // Upgrade by re-pointing this same guest and keeping a back chip.
        try {
          bridge.onOpenRequested(reservation.lease, () => {});
        } catch {}

        wrapper.appendChild(view);
        document.body.appendChild(wrapper);
        guest.wrapper = wrapper;
        guest.webview = view;
        return guest;
      })();
      guest.promise.catch(() => {
        guest.promise = null;
      });
      return guest.promise;
    }

    function showGuest(el, attempt) {
      if (!guest.wrapper || !el) return;
      const rect = el.getBoundingClientRect();
      // The host sizes a custom main panel to its content, so the slot box is
      // short. Take left/width/top from it, then run down to the window bottom:
      // that band belongs to the panel either way.
      // ponytail: assumes nothing is docked below the panel area; if the shell
      // grows a footer, clamp the height against its top edge instead.
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(window.innerHeight - rect.top));
      // A zero box is a measurement taken before React swapped the panel subtree
      // in (closing the preview does exactly that). Retry a few frames instead of
      // parking the guest at 0×0 until the next resize.
      if ((width < 20 || height < 20) && (attempt || 0) < 10) {
        const next = (attempt || 0) + 1;
        requestAnimationFrame(() => showGuest(el, next));
        return;
      }
      const style = guest.wrapper.style;
      style.display = 'block';
      style.left = rect.left + 'px';
      style.top = rect.top + 'px';
      style.width = width + 'px';
      style.height = height + 'px';

      const view = guest.webview;
      if (view && height > 20) {
        // Size the element in pixels too: a guest tracks a definite box more
        // reliably than a percentage one.
        view.style.display = 'flex';
        view.style.width = width + 'px';
        view.style.height = height + 'px';
        if (guest.appliedHeight !== height) {
          guest.appliedHeight = height;
          nudgeGuest();
        }
      }
    }

    // A guest keeps its old viewport unless it sees a real size delta, so a
    // first layout that lands on the final number can leave it at 150px tall.
    function nudgeGuest() {
      const view = guest.webview;
      if (!view) return;
      const height = parseFloat(view.style.height);
      if (!(height > 20)) return;
      view.style.height = Math.max(1, height - 1) + 'px';
      requestAnimationFrame(() => {
        if (guest.webview === view) view.style.height = height + 'px';
      });
    }

    function hideGuest() {
      if (guest.wrapper) guest.wrapper.style.display = 'none';
    }

    // A guest can be left dead: hidden while navigating, torn down by the shell,
    // or parked at 0×0. Rebuilding is the only reliable recovery, and it costs
    // nothing but one page load — the shell caches the partition per LEASE_KEY,
    // so the login survives the rebuild.
    async function rebuildGuest() {
      const view = guest.webview;
      const lease = view ? view.getAttribute('name') : '';
      try {
        if (view && view.parentElement) view.parentElement.removeChild(view);
        if (guest.wrapper && guest.wrapper.parentElement) guest.wrapper.parentElement.removeChild(guest.wrapper);
      } catch {}
      try {
        const bridge = window.dshDesktop && window.dshDesktop.browser;
        if (bridge && lease && typeof bridge.release === 'function') bridge.release(lease);
      } catch {}
      guest.wrapper = null;
      guest.webview = null;
      guest.promise = null;
      guest.appliedHeight = -1;
      return ensureGuest();
    }

    // ---------------------------------------------------------------------
    // Components.
    // ---------------------------------------------------------------------
    function WebChatIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-3.2-6.6' }),
        h('path', { d: 'M20.5 3.5v5h-5' }),
        h('path', { d: 'M8.6 13.2l2 2 4.2-4.6' }),
      );
    }

    const SELECT = {
      maxWidth: 240,
      padding: '3px 6px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
      background: 'var(--dsw-alias-bg-layer-2, #fafafa)',
      color: 'var(--dsw-alias-label-primary, #111)',
      fontSize: 12,
    };

    function Picker({ label, value, options, onChange }) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h('span', { style: CAPTION }, label),
        h(
          'select',
          { value: value || '', style: SELECT, onChange: (event) => onChange(event.target.value) },
          options.length === 0 ? h('option', { value: '' }, '（空）') : null,
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      );
    }

    function WebChatPanel({ api }) {
      const slotRef = useRef(null);
      const rootRef = useRef(null);
      // The shell sizes a custom main panel to its content, so the panel box is
      // as short as this toolbar. Force the box to run to the window bottom:
      // otherwise the guest is clipped to a one-row strip even when its own
      // element is taller.
      const [band, setBand] = useState(0);
      const [status, setStatus] = useState('loading');
      const [failure, setFailure] = useState('');
      const [draft, setDraft] = useState(null);
      // Which overlay is open: null = the page itself, 'take' = carry a web
      // round into a session, 'feed' = carry a DSH answer into the page.
      const [panel, setPanel] = useState(null);
      const [rounds, setRounds] = useState([]);
      const [roundIndex, setRoundIndex] = useState(-1);
      const [answers, setAnswers] = useState([]);
      const [answerIndex, setAnswerIndex] = useState(0);
      const [chats, setChats] = useState([]);
      const [chatsKnown, setChatsKnown] = useState(false);
      const [chatHref, setChatHref] = useState('');
      const [chatCurrent, setChatCurrent] = useState('');
      const [targets, setTargets] = useState(null);
      const [targetWorkspace, setTargetWorkspace] = useState('');
      const [targetSession, setTargetSession] = useState('');
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState('');
      const [noteTone, setNoteTone] = useState('info');

      const sync = useCallback(() => {
        showGuest(slotRef.current);
      }, []);

      useEffect(() => {
        const measure = () => {
          const el = rootRef.current;
          if (!el) return;
          // Height does not move the panel's top edge, so measuring before and
          // after the band is applied gives the same number: no feedback loop.
          const top = el.getBoundingClientRect().top;
          const height = Math.max(240, window.innerHeight - top);
          setBand((prev) => (Math.abs(prev - height) < 1 ? prev : height));
        };
        measure();
        const frames = [];
        for (let i = 0; i < 6; i += 1) frames.push(requestAnimationFrame(measure));
        window.addEventListener('resize', measure);
        return () => {
          window.removeEventListener('resize', measure);
          for (const frame of frames) cancelAnimationFrame(frame);
        };
      }, []);

      useEffect(() => {
        if (status === 'ready') sync();
      }, [band, status, sync]);

      useEffect(() => {
        let alive = true;
        const observer = new ResizeObserver(sync);
        if (slotRef.current) observer.observe(slotRef.current);
        window.addEventListener('resize', sync);
        ensureGuest()
          .then(() => {
            if (!alive) return;
            setStatus('ready');
            sync();
          })
          .catch((error) => {
            if (!alive) return;
            setStatus('error');
            setFailure(error && error.message ? error.message : String(error));
          });
        const frames = [];
        for (let i = 0; i < 8; i += 1) frames.push(requestAnimationFrame(sync));
        return () => {
          alive = false;
          observer.disconnect();
          window.removeEventListener('resize', sync);
          for (const frame of frames) cancelAnimationFrame(frame);
          hideGuest();
        };
      }, [sync]);

      useEffect(() => {
        if (status !== 'ready') return;
        if (panel === null) showGuest(slotRef.current);
        else hideGuest();
      }, [panel, status]);

      // Target list is only read when the preview opens, so a closed panel costs
      // nothing. Defaults to the session the user is already watching.
      useEffect(() => {
        if (panel !== 'take') return undefined;
        let alive = true;
        Promise.resolve(api.targets())
          .then((value) => {
            if (!alive || !value) return;
            setTargets(value);
            const current = value.current;
            const holder =
              value.workspaces.find((item) => current && item.sessionIds.indexOf(current) >= 0) ||
              value.workspaces.find((item) => item.sessionIds.length > 0) ||
              value.workspaces[0];
            setTargetWorkspace(holder ? holder.id : '');
            setTargetSession(current || (holder && holder.sessionIds[0]) || (holder ? NEW_SESSION : ''));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [panel]);

      const workspaceChoices = targets
        ? targets.workspaces.map((item) => ({ value: item.id, label: item.label }))
        : [];
      const holder = targets ? targets.workspaces.find((item) => item.id === targetWorkspace) : null;
      const sessionChoices = [];
      if (holder) {
        sessionChoices.push({ value: NEW_SESSION, label: '＋ 新会话（在此工作区新建）' });
        holder.sessionIds
          .map((id) => {
            const info = (targets.info && targets.info[id]) || {};
            return {
              value: id,
              label: (info.title || (info.blank ? '空会话' : '') || id.slice(0, 8)) +
                (info.updatedAt ? ' · ' + new Date(info.updatedAt).toLocaleDateString() : ''),
              at: info.updatedAt || 0,
            };
          })
          .sort((left, right) => right.at - left.at)
          .forEach((item) => sessionChoices.push(item));
      }

      // Every guest call is one self-contained script: the code runs in the page,
      // so the function is serialized and invoked with its arguments.
      const runGuest = async (action, arg) => {
        const resident = await ensureGuest();
        const script =
          '(' + guestOp.toString() + ')(' + JSON.stringify(action) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')';
        const value = await resident.webview.executeJavaScript(script, true);
        return value && typeof value === 'object' ? value : {};
      };

      const listRounds = async () => {
        const value = await runGuest('rounds', null);
        return Array.isArray(value.rounds) ? value.rounds : [];
      };

      const capture = async (index) => {
        const value = await runGuest('capture', typeof index === 'number' ? index : -1);
        return {
          text: typeof value.text === 'string' ? value.text.trim() : '',
          generating: value.generating === true,
        };
      };

      const listChats = async () => {
        const value = await runGuest('chats', null);
        return {
          chats: Array.isArray(value.chats) ? value.chats : [],
          current: typeof value.current === 'string' ? value.current : '',
        };
      };

      const openChat = async (href) => {
        const resident = await ensureGuest();
        await resident.webview.executeJavaScript(
          'location.href = ' + JSON.stringify(href) + '; true',
          true,
        );
      };

      // Picking a row in the round select re-reads that round, so the textarea
      // always mirrors the choice rather than the button that opened the panel.
      const loadRound = async (index) => {
        setBusy('round');
        setNote('');
        try {
          const result = await capture(index);
          if (result.generating) {
            setNote('这一轮还在生成，等它停了再抓');
            setNoteTone('error');
            return;
          }
          setDraft(result.text);
          if (!result.text) {
            setNote('这一轮没抓到内容，可以手动粘贴');
            setNoteTone('error');
          }
        } catch (error) {
          setNote('抓取失败：' + (error && error.message ? error.message : String(error)));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      const onTakeaway = async () => {
        setBusy('take');
        setNote('');
        try {
          const list = await listRounds();
          const last = list.length - 1;
          setRounds(list);
          setRoundIndex(last);
          setPanel('take');
          if (last < 0) {
            setDraft('');
            setNote('没找到网页里的回答：可能还没登录，或这个对话还没有回复；可以在下面手动粘贴');
            setNoteTone('error');
            return;
          }
          await loadRound(last);
        } catch (error) {
          setRounds([]);
          setRoundIndex(-1);
          setPanel('take');
          setDraft('');
          setNote('抓取失败：' + (error && error.message ? error.message : String(error)) + '，可在下面手动粘贴');
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      // Copy never touches the preview: a failed copy is a note, not a panel
      // takeover.
      const onQuickCopy = async () => {
        setBusy('copy');
        setNote('');
        try {
          const result = await capture();
          if (result.generating) {
            setNote('网页还在生成，等它停了再复制');
            setNoteTone('error');
            return;
          }
          const text = result.text;
          if (!text) {
            setNote('没抓到内容：可能还没登录，或这一轮还没有回答');
            setNoteTone('error');
            return;
          }
          await navigator.clipboard.writeText(text);
          setNote('已复制 ' + text.length + ' 个字符');
          setNoteTone('ok');
        } catch (error) {
          setNote('抓取失败：' + (error && error.message ? error.message : String(error)));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      // Reload is also the recovery path: rebuilding the guest fixes a blank or
      // dead view, which a plain reload() cannot.
      const onReload = async () => {
        setBusy('reload');
        setNote('');
        try {
          await rebuildGuest();
          sync();
          setTimeout(() => {
            nudgeGuest();
          }, 400);
        } catch (error) {
          setNote('重载失败：' + (error && error.message ? error.message : String(error)));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      // Agent → web: collect this conversation's answers so the user can pick a
      // round, and offer the page's conversation list as the destination.
      const onFeedBack = async () => {
        setBusy('feed');
        setNote('');
        try {
          const list = await api.answers();
          if (!list || list.length === 0) {
            setNote('当前会话还没有回答可以搬运');
            setNoteTone('error');
            return;
          }
          setAnswers(list.map((item) => (typeof item === 'string' ? { text: item } : item)));
          setAnswerIndex(0);
          setPanel('feed');
          setChatsKnown(false);
          try {
            const found = await listChats();
            setChats(found.chats);
            setChatCurrent(found.current);
            setChatHref(found.current);
          } catch {
            setChats([]);
          } finally {
            setChatsKnown(true);
          }
        } catch (error) {
          setNote(error && error.message ? error.message : String(error));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      const onFeedConfirm = async () => {
        const text = feedText(answers[answerIndex]).trim();
        if (!text) {
          setNote('这一轮是空的');
          setNoteTone('error');
          return;
        }
        setBusy('feed');
        setNote('');
        try {
          if (chatHref && chatCurrent && chatHref !== chatCurrent) {
            await openChat(chatHref);
            await new Promise((resolve) => setTimeout(resolve, 1600));
          }
          setPanel(null);
          const resident = await ensureGuest();
          const script = '(' + fillGuest.toString() + ')(' + JSON.stringify(text) + ')';
          const result = await resident.webview.executeJavaScript(script, true);
          if (result && result.ok) {
            setNote('已填入网页输入框 ' + result.length + ' 字，检查后按网页的发送');
            setNoteTone('ok');
          } else {
            setNote('没找到网页输入框，等页面加载完再试');
            setNoteTone('error');
          }
        } catch (error) {
          setNote(error && error.message ? error.message : String(error));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      const onSend = async () => {
        const text = (draft || '').trim();
        if (!text) return;
        setBusy('send');
        setNote('');
        try {
          const target = targetSession === NEW_SESSION ? await api.create(targetWorkspace) : targetSession;
          await api.send(text, target);
          setDraft(null);
          setPanel(null);
        } catch (error) {
          setNote(error && error.message ? error.message : String(error));
          setNoteTone('error');
        } finally {
          setBusy('');
        }
      };

      const onCopyDraft = async () => {
        try {
          await navigator.clipboard.writeText(draft || '');
          setNote('已复制到剪贴板');
          setNoteTone('ok');
        } catch (error) {
          setNote('复制失败：' + (error && error.message ? error.message : String(error)));
          setNoteTone('error');
        }
      };

      const toolbar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
            flex: 'none',
          },
        },
        h('span', { style: { fontSize: 13, fontWeight: 600 } }, '网页版 DeepSeek'),
        h('span', { style: { ...CAPTION } }, '免费 · 不消耗额度'),
        h('span', { style: { flex: '1 1 auto' } }),
        note
          ? h(
              'span',
              {
                style: {
                  ...CAPTION,
                  color: noteTone === 'error' ? 'var(--dsw-alias-danger-primary, #dc2626)' : CAPTION.color,
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              note,
            )
          : null,
        h('button', { type: 'button', style: { ...BTN, opacity: busy ? 0.6 : 1 }, disabled: !!busy, onClick: onFeedBack }, busy === 'feed' ? '搬运中…' : '喂回去'),
        h('button', { type: 'button', style: { ...BTN, opacity: busy ? 0.6 : 1 }, disabled: !!busy, onClick: onTakeaway }, busy === 'take' ? '抓取中…' : '带走'),
        h('button', { type: 'button', style: { ...BTN, opacity: busy ? 0.6 : 1 }, disabled: !!busy, onClick: onQuickCopy }, '复制'),
        h('button', { type: 'button', style: BTN, onClick: onReload }, '刷新'),
      );

      const statusOverlay =
        status === 'ready'
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  textAlign: 'center',
                  fontSize: 13,
                  color: 'var(--dsw-alias-label-secondary, #666)',
                },
              },
              status === 'loading' ? '正在挂载网页版会话…' : failure,
            );

      const roundChoices = rounds.map((item, index) => ({ value: String(index), label: item.label }));
      // The same shape the take side produces: the question above the answer, so
      // the other end sees what was asked, not a bare reply.
      const feedText = (item) => {
        if (!item) return '';
        const question = (item.question || '').trim();
        return question ? '> 我（DSH）问：' + question + '\n\n' + item.text : item.text;
      };

      const answerChoices = answers.map((item, index) => ({
        value: String(index),
        label:
          (typeof item.turn === 'number' ? '轮 ' + item.turn + ' · ' : '') +
          (item.question ? '问：' + item.question.replace(/\s+/g, ' ').slice(0, 24) : '（无提问）') +
          ' · ' +
          item.text.length +
          ' 字',
      }));
      const chatChoices = chats.map((item) => ({
        value: item.href,
        label: (item.href === chatCurrent ? '（当前）' : '') + item.label,
      }));

      const takeOverlay =
        panel !== 'take'
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: 14,
                  background: 'var(--dsw-alias-bg-layer-1, #fff)',
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, h('span', { style: { fontSize: 13, fontWeight: 600 } }, '带走网页里的一轮对话'), h('span', { style: CAPTION }, '先选哪一轮，再选发到哪个会话')),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 12, flex: 'none', flexWrap: 'wrap' } },
                h(Picker, {
                  label: '网页轮次',
                  value: String(roundIndex),
                  options: roundChoices,
                  onChange: (value) => {
                    const next = Number(value);
                    setRoundIndex(next);
                    loadRound(next);
                  },
                }),
                h(Picker, {
                  label: '工作区',
                  value: targetWorkspace,
                  options: workspaceChoices,
                  onChange: (value) => {
                    setTargetWorkspace(value);
                    const next = targets ? targets.workspaces.find((item) => item.id === value) : null;
                    setTargetSession(next && next.sessionIds.length > 0 ? next.sessionIds[0] : '');
                  },
                }),
                h(Picker, { label: '会话', value: targetSession, options: sessionChoices, onChange: setTargetSession }),
                h('span', { style: { flex: '1 1 auto' } }),
                h('span', { style: CAPTION }, '发送会作为一条用户消息进入该会话，会消耗额度'),
              ),
              h('textarea', {
                value: draft,
                spellCheck: false,
                onChange: (event) => setDraft(event.target.value),
                style: {
                  flex: '1 1 auto',
                  minHeight: 0,
                  resize: 'none',
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
                  background: 'var(--dsw-alias-bg-layer-2, #fafafa)',
                  color: 'var(--dsw-alias-label-primary, #111)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                },
              }),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
                h('span', { style: { ...CAPTION, color: noteTone === 'error' ? 'var(--dsw-alias-danger-primary, #dc2626)' : CAPTION.color } }, note || '发送会作为一条用户消息进入 agent 会话，会消耗额度'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { type: 'button', style: BTN, onClick: () => { setPanel(null); setDraft(null); setNote(''); } }, '取消'),
                h('button', { type: 'button', style: BTN, onClick: onCopyDraft }, '复制'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...BTN, opacity: busy || !draft.trim() ? 0.6 : 1, fontWeight: 600 },
                    disabled: !!busy || !draft.trim(),
                    onClick: onSend,
                  },
                  busy === 'send' ? '发送中…' : '发送到会话',
                ),
              ),
            );

      const feedOverlay =
        panel !== 'feed'
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: 14,
                  background: 'var(--dsw-alias-bg-layer-1, #fff)',
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, h('span', { style: { fontSize: 13, fontWeight: 600 } }, '喂回网页版'), h('span', { style: CAPTION }, '选这一侧的一轮回答，写进网页的输入框')),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 12, flex: 'none', flexWrap: 'wrap' } },
                h(Picker, { label: 'DSH 回答', value: String(answerIndex), options: answerChoices, onChange: (value) => setAnswerIndex(Number(value)) }),
                chatChoices.length > 1
                  ? h(Picker, { label: '网页对话', value: chatHref, options: chatChoices, onChange: setChatHref })
                  : h('span', { style: CAPTION }, chatsKnown ? '网页对话：当前这个' : '正在读取网页对话列表…'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('span', { style: CAPTION }, '只填进去，不自动发送'),
              ),
              h('textarea', {
                readOnly: true,
                value: feedText(answers[answerIndex]),
                spellCheck: false,
                style: {
                  flex: '1 1 auto',
                  minHeight: 0,
                  resize: 'none',
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
                  background: 'var(--dsw-alias-bg-layer-2, #fafafa)',
                  color: 'var(--dsw-alias-label-primary, #111)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                },
              }),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
                h('span', { style: { ...CAPTION, color: noteTone === 'error' ? 'var(--dsw-alias-danger-primary, #dc2626)' : CAPTION.color } }, note || '填入后可以在网页里改，再按网页的发送'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { type: 'button', style: BTN, onClick: () => { setPanel(null); setNote(''); } }, '取消'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...BTN, fontWeight: 600, opacity: busy ? 0.6 : 1 },
                    disabled: !!busy,
                    onClick: onFeedConfirm,
                  },
                  busy === 'feed' ? '填入中…' : '填入网页输入框',
                ),
              ),
            );

      const preview = panel === 'take' ? takeOverlay : feedOverlay;

      return h(
        'div',
        {
          ref: rootRef,
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: band ? band + 'px' : '100%',
            minHeight: 0,
          },
        },
        toolbar,
        h(
          'div',
          { style: { position: 'relative', flex: '1 1 auto', minHeight: 0 } },
          h('div', { ref: slotRef, style: { position: 'absolute', inset: 0 } }),
          statusOverlay,
          preview,
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Apply.
    // ---------------------------------------------------------------------
    function apply(ctx) {
      const sessions = () => ctx.get('sessions') || ctx.get('sessionTree');

      const currentSessionId = () => {
        try {
          const byId = sessions().list.getSnapshot().byId;
          for (const row of Object.values(byId)) {
            if (row !== undefined && (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) > 0) return row.id;
          }
        } catch {}
        return undefined;
      };

      // Reverse handoff reads the transcript off the client's own event window.
      // `assistant/message` carries {turn, step}: one turn emits several messages
      // (narration, tool steps, the answer), so the LAST step wins. `user/message`
      // carries no turn — only its source — so the pending question is attached
      // to the next assistant turn, and plugin-injected reminders are skipped.
      // Newest first, capped: the picker only has to reach back a few rounds.
      const answers = async (sessionId) => {
        const service = sessions();
        const id = sessionId || currentSessionId();
        if (!service || typeof service.retain !== 'function' || !id) return [];
        const reference = service.retain(id, { source: 'gateway' });
        const textOf = (content) => {
          if (typeof content === 'string') return content.trim();
          if (!content || typeof content !== 'object') return '';
          if (Array.isArray(content)) {
            return content
              .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n\n')
              .trim();
          }
          return typeof content.text === 'string' ? content.text.trim() : '';
        };
        try {
          await reference.ready;
          const window = reference.binding.eventSource.getSnapshot();
          const entries = (window && window.entries) || [];
          const turns = [];
          let pending = '';
          let serial = 0;
          for (const entry of entries) {
            if (!entry || entry.type !== 'event' || !entry.event) continue;
            const event = entry.event;
            if (event.type === 'user/message') {
              const data = event.data || {};
              const source = data.source || {};
              // Injected reminders and compaction baselines are not the user's
              // question, and quoting them would pollute the handoff.
              if (source.kind !== undefined && source.kind !== 'user') continue;
              const text = textOf(data.content);
              if (text && !/^<system-reminder>/i.test(text)) pending = text;
              continue;
            }
            if (event.type !== 'assistant/message') continue;
            const data = event.data || {};
            const text = textOf(data.message && data.message.content);
            if (!text) continue;
            const turn = data.turn !== undefined ? data.turn : event.turn;
            const step = data.step !== undefined ? data.step : event.step;
            const last = turns.length > 0 ? turns[turns.length - 1] : null;
            if (last && turn !== undefined && last.turn === turn) {
              if (step === undefined || last.step === undefined || step >= last.step) {
                last.text = text;
                last.step = step;
              }
              continue;
            }
            serial += 1;
            turns.push({
              turn: turn !== undefined ? turn : '#' + serial,
              step: step,
              text: text,
              question: pending,
            });
            pending = '';
          }
          return turns
            .map((turn) => ({ text: turn.text, question: turn.question, turn: turn.turn, step: turn.step }))
            .reverse()
            .slice(0, 20);
        } finally {
          try {
            reference.release();
          } catch {}
        }
      };

      // `remote.session` is a generated remote namespace: it must be a declared
      // inject, otherwise the call fails with "cannot get property remote.session".
      const remoteSession = () => {
        try {
          const direct = ctx.get('remote.session');
          if (direct && typeof direct.prompt === 'function') return direct;
        } catch {}
        const remote = ctx.get('remote');
        return remote && remote.session && typeof remote.session.prompt === 'function' ? remote.session : null;
      };

      // Titles live on the client's session rows (`row.title` — the shell's own
      // header reads the same field); the Host list is only a fallback, because
      // its projection hints do not always carry `title`.
      const listTargets = async () => {
        const workspaces = [];
        try {
          const service = ctx.get('workspaces');
          if (service && service.list) {
            for (const item of service.list.getSnapshot().items) {
              workspaces.push({
                id: item.workspaceId,
                label: item.title || item.path || item.workspaceId,
                sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.slice() : [],
              });
            }
          }
        } catch {}
        const info = Object.create(null);
        try {
          const byId = sessions().list.getSnapshot().byId || {};
          for (const row of Object.values(byId)) {
            if (!row || !row.id) continue;
            info[row.id] = {
              title: typeof row.title === 'string' ? row.title : '',
              updatedAt: row.updatedAt || (row.lastPromptAt || 0),
              blank: !!row.blank,
            };
          }
        } catch {}
        try {
          const remote = ctx.get('remote');
          const value = await remote.session.list({}, new AbortController().signal);
          for (const item of (value && value.items) || []) {
            const known = info[item.sessionId] || (info[item.sessionId] = { title: '', updatedAt: 0, blank: false });
            const values = item.projections && item.projections.values ? item.projections.values : null;
            if (!known.title && values && typeof values.title === 'string') known.title = values.title;
            if (!known.updatedAt) known.updatedAt = item.updatedAt || 0;
            if (known.blank === false) known.blank = !!item.blank;
          }
        } catch {}
        return { workspaces, info, current: currentSessionId() };
      };

      /**
       * `connectWorkspace` on a fresh id goes Host-side through
       * `sessions.create({ workspaceId })` (verified in app.asar: connectBlank
       * returns `this.sessions.create({ workspaceId })` when no preset is
       * requested), so it hands back the id of a brand-new Session.
       */
      const createIn = async (workspaceId) => {
        if (!workspaceId) throw new Error('先选一个工作区');
        const ui = ctx.get('uiWorkspace');
        if (!ui || typeof ui.connectWorkspace !== 'function') throw new Error('当前客户端不支持新建会话');
        const sessionId = await ui.connectWorkspace(workspaceId);
        if (!sessionId) throw new Error('新建会话失败');
        return sessionId;
      };

      const send = async (text, sessionId) => {
        const session = remoteSession();
        if (!session) throw new Error('当前客户端没有暴露会话接口');
        const target = sessionId || currentSessionId();
        if (!target) throw new Error('先选一个要发送的会话');
        await session.prompt(
          {
            requestId: newId(),
            sessionId: target,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: zone(),
          },
          new AbortController().signal,
        );
        try {
          const ui = ctx.get('uiWorkspace');
          if (ui && typeof ui.openSession === 'function') ui.openSession(target);
        } catch {}
        try {
          const layout = ctx.get('layout');
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('conversation');
        } catch {}
      };

      const slots = ctx.slots || ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') {
        console.warn('[webchat] slots service is unavailable; panel not registered');
        return;
      }

      const disposers = [];
      disposers.push(
        slots.inject('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => '网页版' }, WebChatIcon),
        ),
      );
      disposers.push(
        slots.inject('main', () =>
          slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ api: { send, targets: listTargets, create: createIn, answers } }) }, WebChatPanel),
        ),
      );

      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {}
        }
        hideGuest();
      }, 'webchat: panel');
    }

    return { inject: ['slots', 'sessions', 'layout', 'remote', 'remote.session'], apply };
  },
});
