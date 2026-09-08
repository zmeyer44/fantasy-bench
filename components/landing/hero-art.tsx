import Image from "next/image";

import styles from "./hero.module.css";

/** The asset has real alpha; construction lines remain crisp at every size. */
export function HeroArt() {
  return (
    <div className={styles.art} aria-hidden="true">
      <div className={styles.blueBand} />
      <svg className={styles.construction} viewBox="0 0 1000 835" fill="none">
        <defs>
          <pattern id="helmet-grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M100 0H0V100" stroke="currentColor" strokeOpacity=".13" />
          </pattern>
          <linearGradient id="helmet-orbit" x1="150" y1="0" x2="700" y2="720" gradientUnits="userSpaceOnUse">
            <stop stopColor="currentColor" stopOpacity=".9" />
            <stop offset="1" stopColor="currentColor" stopOpacity=".15" />
          </linearGradient>
        </defs>
        <path d="M160 0V665M300 0V835M467 0V835M575 0V835M815 230V805M900 230V644M57 76H748M57 240H968M0 328H814M57 438H968M57 540H968M57 641H909M217 765H815" stroke="currentColor" strokeOpacity=".19" />
        <path d="M57 240H968V642H57Z" fill="url(#helmet-grid)" />
        <circle cx="465" cy="371" r="348" stroke="url(#helmet-orbit)" />
        <path d="M467 8V785M467 76H780" stroke="currentColor" strokeOpacity=".65" />
        <path d="M57 76H185M215 76V180M445 76H747M467 216H747" stroke="currentColor" strokeOpacity=".6" />
        <path d="M160 111h15v16M160 127v-16l16 16M0 359h25M12 346v27M924 493h25M936 480v27" stroke="currentColor" strokeOpacity=".65" />
        <g stroke="var(--hero-lime)">
          <path d="M62 328v44h42l4-44M467 490v42h32M252 79l5 8m-4-9 2 12" />
          <path d="M481 388v20m-10-10h20M493 402l8-10m-8 0 8 10" />
        </g>
        <g fill="var(--hero-lime)">
          <path d="M648 69h14v14h-14M463 532h8v8h-8M463 216h6v6h-6" />
          <circle cx="108" cy="328" r="3" />
          <path d="M850 577h10v10h-10m21-10h10v10h-10m-10 1h10v10h-10m-11 1h10v10h-10m21-10h10v10h-10" />
        </g>
      </svg>
      <div className={styles.helmet}>
        <Image src="/images/hero-helmet.png" alt="" fill sizes="(max-width: 600px) 85vw, (max-width: 900px) 70vw, 41vw" loading="eager" fetchPriority="high" />
      </div>
      <div className={styles.strategy}>
        <span className={styles.marker}>01</span>
        <p>Strategy<br />Prompts<br />Real results</p>
      </div>
      <p className={styles.guidance}>Human<br />guidance.<br />AI execution.<br />Real<br />competition.<span className={styles.dash} /></p>
      <div className={styles.fieldNote}>
        <svg viewBox="0 0 90 72" fill="none">
          <path d="M1 1h88v70H1ZM45 1v70M1 21h20v30H1m88-30H69v30h20M1 30h7v12H1m88-12h-7v12h7" stroke="currentColor" />
          <circle cx="45" cy="36" r="8" stroke="currentColor" />
        </svg>
        <p>Data<br />Models<br />Matchups<br />Edge</p>
      </div>
      <dl className={styles.stats}>
        <div><dt>Teams</dt><dd>12</dd></div>
        <div><dt>Champion</dt><dd>1</dd></div>
        <div><dt>Strategies</dt><dd>∞</dd></div>
      </dl>
      <p className={styles.season}>2026<br />Season<br />Loading<span className={styles.dash} /></p>
    </div>
  );
}
