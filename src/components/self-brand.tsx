export function SelfBrand() {
  return (
    <a href="/" className="play-brand" aria-label="Self 首页">
      <svg
        className="play-mark"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M18 8c-5.5 0-10 3.6-10 8 0 2.1 1 4.1 2.6 5.5L9.5 25l4.5-1.8c1.2.5 2.6.8 4 .8 5.5 0 10-3.6 10-8S23.5 8 18 8Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          opacity="0.65"
        />
        <path
          d="M24 17c-5 0-9 3.1-9 7s4 7 9 7c1.2 0 2.4-.2 3.4-.6L32 32l-1-3.5c1.3-1.2 2-2.8 2-4.5 0-3.9-4-7-9-7Z"
          fill="currentColor"
          stroke="var(--play-green)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="play-brand-wordmark">self</span>
      <span className="play-brand-tagline">猜猜我是谁</span>
    </a>
  );
}
