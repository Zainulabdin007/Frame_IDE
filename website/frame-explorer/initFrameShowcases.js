export function initFrameShowcases() {
  const roots = document.querySelectorAll('[data-frame-showcase]')
  const cleanups = []

  const sideBriefings = {
    frame: {
      title: 'Agent · Models',
      html: `
        <div class="fs-chip">Local · Efficient · read-only demo</div>
        <div class="fs-bubble fs-bubble--user">Which model is active for this workspace, and what are we learning?</div>
        <div class="fs-tool"><strong>read</strong> Frame/models/manifest.json</div>
        <div class="fs-tool"><strong>stat</strong> VRAM 6.1 GB · context 32k · ~38 tok/s</div>
        <div class="fs-bubble fs-bubble--assistant">Active runtime is <code>Efficient · Qwen2.5-Coder 7B</code> (GGUF Q5_K_M). LoRA adapter last trained Tue 2:14 AM. Queue has 3 pending preference signals — next offline train after 2 more approvals.</div>
        <div class="fs-bubble fs-bubble--user">Would Maximum 14B be worth it on this machine?</div>
        <div class="fs-tool"><strong>probe</strong> nvidia-smi · free VRAM ≈ 5.8 GB</div>
        <div class="fs-bubble fs-bubble--assistant">Not safely. 14B Q5 needs ~12 GB VRAM. Stay on Efficient, or drop to Q4_K_M if you need headroom for embeddings.</div>
        <p class="fs-chat__note">Messaging disabled in preview</p>
      `,
    },
    search: {
      title: 'Agent · Search',
      html: `
        <div class="fs-chip">Local · workspace index</div>
        <div class="fs-bubble fs-bubble--user">Find every throw site that still uses bare <code>Error</code> in middleware.</div>
        <div class="fs-tool"><strong>grep</strong> throw new Error\\( · src/middleware</div>
        <div class="fs-tool"><strong>grep</strong> AppError · src/errors src/middleware</div>
        <div class="fs-bubble fs-bubble--assistant">3 bare <code>Error</code> throws in <code>auth.ts</code> / <code>session.ts</code>. <code>AppError</code> is defined in <code>src/errors/AppError.ts</code> and already used in 11 call sites. Memory also has a pending preference: Prefer AppError.</div>
        <div class="fs-bubble fs-bubble--user">Rank by blast radius — what breaks first?</div>
        <div class="fs-tool"><strong>rank</strong> callers of auth middleware · 14 routes</div>
        <div class="fs-bubble fs-bubble--assistant">Highest impact: <code>src/routes/session.ts</code> (login + refresh). Then webhook ingress. I’ll keep the search hits pinned so Confirm can target those first.</div>
        <p class="fs-chat__note">Messaging disabled in preview</p>
      `,
    },
    scm: {
      title: 'Agent · Source Control',
      html: `
        <div class="fs-chip">Local · git signals only</div>
        <div class="fs-bubble fs-bubble--user">Draft a commit from what Frame already saw me Accept.</div>
        <div class="fs-tool"><strong>git status</strong> staged 2 · unstaged 1</div>
        <div class="fs-tool"><strong>git diff --cached</strong> auth.ts AppError.ts</div>
        <div class="fs-bubble fs-bubble--assistant">Suggested message matches your last 3 auth commits:<br><code>fix(auth): use AppError for guard failures</code><br>Staged Accepts are strong learn signals. The discarded hunk in <code>session.ts</code> will <em>not</em> train.</div>
        <div class="fs-bubble fs-bubble--user">Keep the draft editable — don’t auto-commit.</div>
        <div class="fs-bubble fs-bubble--assistant">Understood. Draft stays in the SCM panel only. Nothing leaves the machine; no remote push from Frame.</div>
        <p class="fs-chat__note">Messaging disabled in preview</p>
      `,
    },
    ext: {
      title: 'Agent · Extensions',
      html: `
        <div class="fs-chip">Policy · no phone-home</div>
        <div class="fs-bubble fs-bubble--user">What’s safe to install without breaking local-only?</div>
        <div class="fs-tool"><strong>list</strong> Frame Models · Frame Learning · Local Diff Lens</div>
        <div class="fs-bubble fs-bubble--assistant">Built-ins are fine. <code>Local Diff Lens</code> stays on-device. <code>Offline Spell for Code</code> (12 MB) is recommended. Anything with a network entitlement is blocked by default in Frame builds.</div>
        <div class="fs-bubble fs-bubble--user">Can Learning share adapters across projects?</div>
        <div class="fs-bubble fs-bubble--assistant">No — adapters are per-project by design. Cross-project bleed is exactly what Frame refuses to do.</div>
        <p class="fs-chat__note">Messaging disabled in preview</p>
      `,
    },
  }

  roots.forEach((root) => {
    // Remove toast UI entirely if present
    root.querySelectorAll('[data-fs-toast]').forEach((el) => el.remove())

    const titles = {
      frame: 'Frame Desktop · Models',
      search: 'Frame Desktop · Search',
      scm: 'Frame Desktop · Source Control',
      ext: 'Frame Desktop · Extensions',
    }

    const agentWin = root.querySelector('[data-fs-win="agent"]')
    const agentBody = agentWin?.querySelector('.fs-chat__body')
    const agentTitle = agentWin?.querySelector('.fs-title')

    const showPanel = (id) => {
      root.querySelectorAll('[data-fs-act]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-fs-act') === id)
      })
      root.querySelectorAll('[data-fs-view]').forEach((view) => {
        const on = view.getAttribute('data-fs-view') === id
        view.classList.toggle('is-active', on)
        view.hidden = !on
        if (on) view.scrollTop = 0
      })
      const title = root.querySelector('[data-fs-win="desktop"] [data-fs-win-title]')
      if (title && titles[id]) title.textContent = titles[id]

      // Side agent window mirrors the selected activity panel
      const briefing = sideBriefings[id]
      if (briefing && agentBody) {
        agentBody.innerHTML = briefing.html
        agentBody.scrollTop = 0
        if (agentTitle) agentTitle.textContent = briefing.title
        if (agentWin) {
          agentWin.classList.remove('is-min')
          agentWin.style.zIndex = String(Date.now() % 100000)
          root.querySelectorAll('.fs-win').forEach((w) => w.classList.remove('is-front'))
          agentWin.classList.add('is-front')
        }
      }
    }

    root.querySelectorAll('[data-fs-act]').forEach((btn) => {
      const onClick = () => showPanel(btn.getAttribute('data-fs-act'))
      btn.addEventListener('click', onClick)
      cleanups.push(() => btn.removeEventListener('click', onClick))
    })

    const toggle = root.querySelector('[data-fs-toggle]')
    if (toggle) {
      const onToggle = () => {
        const off = toggle.classList.toggle('is-off')
        toggle.textContent = off ? 'Off' : 'On'
      }
      toggle.addEventListener('click', onToggle)
      cleanups.push(() => toggle.removeEventListener('click', onToggle))
    }

    // Requirements button: expand inline meta instead of toast
    root.querySelectorAll('[data-fs-req]').forEach((el) => {
      const onClick = () => {
        const card = el.closest('.fs-card')
        if (!card) return
        let detail = card.querySelector('[data-fs-req-detail]')
        if (detail) {
          detail.remove()
          return
        }
        detail = document.createElement('div')
        detail.className = 'fs-card__meta'
        detail.setAttribute('data-fs-req-detail', '')
        detail.style.marginTop = '8px'
        detail.textContent =
          'Needs ~12 GB VRAM · Q5_K_M · downloads stay in ~/Library/Application Support/Frame/models'
        card.appendChild(detail)
      }
      el.addEventListener('click', onClick)
      cleanups.push(() => el.removeEventListener('click', onClick))
    })

    const accept = root.querySelector('[data-fs-accept]')
    const undo = root.querySelector('[data-fs-undo]')
    const pref = root.querySelector('[data-fs-pref]')
    const status = root.querySelector('[data-fs-status]')

    if (accept) {
      const onAccept = () => {
        accept.classList.add('is-done')
        if (undo) undo.classList.remove('is-done')
        if (status) status.innerHTML = 'Applied to <strong>auth.ts</strong> · Undo available'
        if (pref) pref.classList.add('is-visible')
      }
      accept.addEventListener('click', onAccept)
      cleanups.push(() => accept.removeEventListener('click', onAccept))
    }

    if (undo) {
      const onUndo = () => {
        undo.classList.add('is-done')
        if (accept) accept.classList.remove('is-done')
        if (status) status.innerHTML = 'Reverted · waiting for a new plan'
        if (pref) pref.classList.remove('is-visible')
      }
      undo.addEventListener('click', onUndo)
      cleanups.push(() => undo.removeEventListener('click', onUndo))
    }

    const approve = root.querySelector('[data-fs-approve]')
    const reject = root.querySelector('[data-fs-reject]')
    if (approve) {
      const onApprove = () => pref?.classList.remove('is-visible')
      approve.addEventListener('click', onApprove)
      cleanups.push(() => approve.removeEventListener('click', onApprove))
    }
    if (reject) {
      const onReject = () => pref?.classList.remove('is-visible')
      reject.addEventListener('click', onReject)
      cleanups.push(() => reject.removeEventListener('click', onReject))
    }

    const desk = root.querySelector('[data-fs-desk]')
    const dock = root.querySelector('[data-fs-dock]')
    if (!desk) return

    let z = 10
    const bringFront = (win) => {
      z += 1
      win.style.zIndex = String(z)
      desk.querySelectorAll('.fs-win').forEach((w) => w.classList.remove('is-front'))
      win.classList.add('is-front')
    }

    const syncDock = () => {
      if (!dock) return
      const minimized = [...desk.querySelectorAll('.fs-win.is-min')]
      dock.hidden = minimized.length === 0
      dock.innerHTML = ''
      minimized.forEach((win) => {
        const label =
          win.querySelector('.fs-title')?.textContent?.trim() ||
          win.getAttribute('data-fs-win') ||
          'Window'
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'fs-dock__item'
        chip.textContent = label
        chip.addEventListener('click', () => {
          win.classList.remove('is-min')
          bringFront(win)
          syncDock()
        })
        dock.appendChild(chip)
      })
    }

    const pct = (px, total) => `${(px / total) * 100}%`

    desk.querySelectorAll('[data-fs-win]').forEach((win) => {
      // Resize handles (edges + corners) for normal-window stretching
      ;['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach((dir) => {
        const handle = document.createElement('div')
        handle.className = `fs-resize fs-resize--${dir}`
        handle.dataset.fsResize = dir
        win.appendChild(handle)
      })

      const onPointerDown = () => bringFront(win)
      win.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => win.removeEventListener('pointerdown', onPointerDown))

      const dragHandle = win.querySelector('[data-fs-drag]')
      if (dragHandle) {
        let dragging = false
        let startX = 0
        let startY = 0
        let originLeft = 0
        let originTop = 0

        const onDown = (e) => {
          if (e.target.closest('.fs-traffic__btn')) return
          if (e.target.closest('[data-fs-resize]')) return
          if (win.classList.contains('is-min')) return
          dragging = true
          bringFront(win)
          const deskRect = desk.getBoundingClientRect()
          const winRect = win.getBoundingClientRect()
          startX = e.clientX
          startY = e.clientY
          originLeft = winRect.left - deskRect.left
          originTop = winRect.top - deskRect.top
          win.classList.add('is-dragging')
          dragHandle.setPointerCapture?.(e.pointerId)
        }

        const onMove = (e) => {
          if (!dragging) return
          const deskRect = desk.getBoundingClientRect()
          const winRect = win.getBoundingClientRect()
          let nextLeft = originLeft + (e.clientX - startX)
          let nextTop = originTop + (e.clientY - startY)
          const maxLeft = Math.max(0, deskRect.width - winRect.width)
          const maxTop = Math.max(0, deskRect.height - winRect.height)
          nextLeft = Math.min(Math.max(0, nextLeft), maxLeft)
          nextTop = Math.min(Math.max(0, nextTop), maxTop)
          win.style.setProperty('--x', pct(nextLeft, deskRect.width))
          win.style.setProperty('--y', pct(nextTop, deskRect.height))
          win.style.left = ''
          win.style.top = ''
        }

        const onUp = () => {
          if (!dragging) return
          dragging = false
          win.classList.remove('is-dragging')
        }

        dragHandle.addEventListener('pointerdown', onDown)
        dragHandle.addEventListener('pointermove', onMove)
        dragHandle.addEventListener('pointerup', onUp)
        dragHandle.addEventListener('pointercancel', onUp)
        cleanups.push(() => {
          dragHandle.removeEventListener('pointerdown', onDown)
          dragHandle.removeEventListener('pointermove', onMove)
          dragHandle.removeEventListener('pointerup', onUp)
          dragHandle.removeEventListener('pointercancel', onUp)
        })
      }

      // Resize interaction
      win.querySelectorAll('[data-fs-resize]').forEach((handle) => {
        let resizing = false
        let dir = ''
        let startX = 0
        let startY = 0
        let startLeft = 0
        let startTop = 0
        let startW = 0
        let startH = 0

        const onDown = (e) => {
          if (win.classList.contains('is-min')) return
          e.preventDefault()
          e.stopPropagation()
          resizing = true
          dir = handle.dataset.fsResize || ''
          bringFront(win)
          win.classList.add('is-resizing')
          const deskRect = desk.getBoundingClientRect()
          const winRect = win.getBoundingClientRect()
          startX = e.clientX
          startY = e.clientY
          startLeft = winRect.left - deskRect.left
          startTop = winRect.top - deskRect.top
          startW = winRect.width
          startH = winRect.height
          handle.setPointerCapture?.(e.pointerId)
        }

        const onMove = (e) => {
          if (!resizing) return
          const deskRect = desk.getBoundingClientRect()
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          const minW = Math.min(220, deskRect.width * 0.25)
          const minH = Math.min(140, deskRect.height * 0.25)

          let left = startLeft
          let top = startTop
          let width = startW
          let height = startH

          if (dir.includes('e')) width = startW + dx
          if (dir.includes('s')) height = startH + dy
          if (dir.includes('w')) {
            width = startW - dx
            left = startLeft + dx
          }
          if (dir.includes('n')) {
            height = startH - dy
            top = startTop + dy
          }

          if (width < minW) {
            if (dir.includes('w')) left = startLeft + startW - minW
            width = minW
          }
          if (height < minH) {
            if (dir.includes('n')) top = startTop + startH - minH
            height = minH
          }

          left = Math.min(Math.max(0, left), deskRect.width - minW)
          top = Math.min(Math.max(0, top), deskRect.height - minH)
          width = Math.min(width, deskRect.width - left)
          height = Math.min(height, deskRect.height - top)

          win.style.setProperty('--x', pct(left, deskRect.width))
          win.style.setProperty('--y', pct(top, deskRect.height))
          win.style.setProperty('--w', pct(width, deskRect.width))
          win.style.setProperty('--h', pct(height, deskRect.height))
          win.classList.remove('is-zoomed')
        }

        const onUp = () => {
          if (!resizing) return
          resizing = false
          win.classList.remove('is-resizing')
        }

        handle.addEventListener('pointerdown', onDown)
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onUp)
        handle.addEventListener('pointercancel', onUp)
        cleanups.push(() => {
          handle.removeEventListener('pointerdown', onDown)
          handle.removeEventListener('pointermove', onMove)
          handle.removeEventListener('pointerup', onUp)
          handle.removeEventListener('pointercancel', onUp)
        })
      })

      const minBtn = win.querySelector('[data-fs-min]')
      if (minBtn) {
        const onMin = (e) => {
          e.stopPropagation()
          win.classList.add('is-min')
          syncDock()
        }
        minBtn.addEventListener('click', onMin)
        cleanups.push(() => minBtn.removeEventListener('click', onMin))
      }

      const closeBtn = win.querySelector('[data-fs-close]')
      if (closeBtn) {
        const onClose = (e) => {
          e.stopPropagation()
          win.classList.add('is-min')
          syncDock()
        }
        closeBtn.addEventListener('click', onClose)
        cleanups.push(() => closeBtn.removeEventListener('click', onClose))
      }

      const maxBtn = win.querySelector('[data-fs-max]')
      if (maxBtn) {
        const onMax = (e) => {
          e.stopPropagation()
          const zoomed = win.classList.toggle('is-zoomed')
          if (zoomed) {
            win.dataset.prevX = win.style.getPropertyValue('--x')
            win.dataset.prevY = win.style.getPropertyValue('--y')
            win.dataset.prevW = win.style.getPropertyValue('--w')
            win.dataset.prevH = win.style.getPropertyValue('--h')
            win.style.setProperty('--x', '2%')
            win.style.setProperty('--y', '2%')
            win.style.setProperty('--w', '96%')
            win.style.setProperty('--h', '96%')
          } else {
            win.style.setProperty('--x', win.dataset.prevX || '4%')
            win.style.setProperty('--y', win.dataset.prevY || '4%')
            win.style.setProperty('--w', win.dataset.prevW || '46%')
            win.style.setProperty('--h', win.dataset.prevH || '88%')
          }
          bringFront(win)
        }
        maxBtn.addEventListener('click', onMax)
        cleanups.push(() => maxBtn.removeEventListener('click', onMax))
      }
    })
  })

  return () => cleanups.forEach((fn) => fn())
}
