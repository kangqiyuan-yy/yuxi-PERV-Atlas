// Scroll-reveal using IntersectionObserver (replays on each enter/leave).
(function () {
  'use strict';

  function reveal(el) {
    if (el.classList.contains('is-visible')) return;
    void el.offsetWidth;
    el.classList.add('is-visible');
  }

  function hide(el) {
    el.classList.remove('is-visible');
  }

  function initScrollReveal() {
    var nodes = document.querySelectorAll('[data-scroll]');
    if (!nodes.length) return;

    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach(reveal);
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            reveal(entry.target);
          } else {
            hide(entry.target);
          }
        });
      },
      {
        threshold: 0.08,
        rootMargin: '0px 0px -5% 0px',
      }
    );

    nodes.forEach(function (el) {
      observer.observe(el);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollReveal);
  } else {
    initScrollReveal();
  }
}());
