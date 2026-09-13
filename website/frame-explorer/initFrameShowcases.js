export function initFrameShowcases() {
  const roots = document.querySelectorAll('[data-frame-showcase]')
  const cleanups = []

  roots.forEach((root) => {
    const toast = root.querySelector('[data-fs-toast]')
    const showToast = (msg) => {
      if (!toast) return
      toast.textContent = msg
      toast.classList.add('is-on')
      clearTimeout(toast._t)
      toast._t = setTimeout(() => toast.classList.remove('is-on'), 1800)
    }

    const titles = {
      frame: 'Frame Desktop · Models',
      search: 'Frame Desktop · Search',
      scm: 'Frame Desktop · Source Control',
      ext: 'Frame Desktop · Extensions',
    }

    root.querySelectorAll('[data-fs-act]').forEach((btn) => {
      const onClick = () => {
        const id = btn.getAttribute('data-fs-act')
        root.querySelectorAll('[data-fs-act]').forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
        root.querySelectorAll('[data-fs-view]').forEach((view) => {
          const on = view.getAttribute('data-fs-view') === id
          view.classList.toggle('is-active', on)
          view.hidden = !on
          if (on) view.scrollTop = 0
        })
        const title = root.querySelector('[data-fs-win="desktop"] [data-fs-win-title]')
        if (title && titles[id]) title.textContent = titles[id]
      }
      btn.addEventListener('click', onClick)
      cleanups.push(() => btn.removeEventListener('click', onClick))
    })

    const toggle = root.querySelector('[data-fs-toggle]')
    if (toggle) {
      const onToggle = () => {
        const off = toggle.classList.toggle('is-off')
        toggle.textContent = off ? 'Off' : 'On'
        showToast(off ? 'Runtime Off' : 'Runtime On')
      }
      toggle.addEventListener('click', onToggle)
      cleanups.push(() => toggle.removeEventListener('click', onToggle))
    }

    root.querySelectorAll('[data-fs-toast-msg]').forEach((el) => {
      const onClick = () => showToast(el.getAttribute('data-fs-toast-msg') || '')
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
        showToast('Edit plan accepted')
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
        showToast('Changes undone')
      }
      undo.addEventListener('click', onUndo)
      cleanups.push(() => undo.removeEventListener('click', onUndo))
    }

    const approve = root.querySelector('[data-fs-approve]')
    const reject = root.querySelector('[data-fs-reject]')
    if (approve) {
      const onApprove = () => {
        if (pref) pref.classList.remove('is-visible')
        showToast('Preference saved · LoRA personalization queued')
      }
      approve.addEventListener('click', onApprove)
      cleanups.push(() => approve.removeEventListener('click', onApprove))
    }
    if (reject) {
      const onReject = () => {
        if (pref) pref.classList.remove('is-visible')
        showToast('Preference rejected')
      }
      reject.addEventListener('click', onReject)
      cleanups.push(() => reject.removeEventListener('click', onReject))
    }

    // Mac-style windows: drag + minimize within the showcase desk
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

    desk.querySelectorAll('[data-fs-win]').forEach((win) => {
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
          win.style.setProperty('--x', `${(nextLeft / deskRect.width) * 100}%`)
          win.style.setProperty('--y', `${(nextTop / deskRect.height) * 100}%`)
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

      const minBtn = win.querySelector('[data-fs-min]')
      if (minBtn) {
        const onMin = (e) => {
          e.stopPropagation()
          win.classList.add('is-min')
          syncDock()
          showToast('Minimized')
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
          showToast('Closed to dock (demo)')
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
