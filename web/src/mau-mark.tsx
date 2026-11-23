/**
 * The Mau mark: a pixel cat face, drawn in the text colour so it follows the theme.
 * With a `weight` it is drawn as lines along the middle of its blocks, that thick (the blocks are about 40): a lighter
 * cat for where it sits among thin icons.
 */
export function MauMark({ size, weight }: { size?: number; weight?: number }) {
  const box = { viewBox: "150 139 720 720", "aria-hidden": true, shapeRendering: "crispEdges", ...(size ? { width: size, height: size } : {}) } as const;
  if (weight === undefined)
    return (
      <svg {...box}>
        <path fill="var(--og-text-strong)" d="M240.395 241.461h69.136v39.834h-69.136zM240.395 281.295h39.506v222.407h-39.506zM207.473 500.382h39.506v102.905h-39.506zM279.901 281.295h59.259v39.834h-59.259zM319.407 321.129h59.259v39.834h-59.259zM358.914 360.963h59.259v39.834h-59.259zM398.420 400.797h217.284v39.834h-217.284zM589.366 380.880h65.844v59.751h-65.844zM622.288 360.963h59.259v39.834h-59.259zM648.626 321.129h65.844v39.834h-65.844zM681.547 281.295h65.844v39.834h-65.844zM711.177 241.461h69.136v39.834h-69.136zM744.099 281.295h39.506v222.407h-39.506zM777.021 500.382h39.506v102.905h-39.506zM372.082 553.494h42.798v116.183h-42.798zM609.119 553.494h42.798v116.183h-42.798zM161.383 649.759h98.765v33.195h-98.765zM263.440 682.954h42.798v36.515h-42.798zM174.551 722.788h88.889v33.195h-88.889zM757.267 646.440h102.058v36.515h-102.058zM714.469 686.274h39.506v33.195h-39.506zM757.267 722.788h88.889v33.195h-88.889z" />
      </svg>
    );
  return (
    <svg {...box} fill="none" stroke="var(--og-text-strong)" strokeWidth={weight}>
      {/* The head: down each side, up each ear and across the top in steps. */}
      <path d="M227 603V502H260V261H300V301H340V341H380V381H420V421H604V381H644V341H684V301H724V261H764V502H797V603" />
      {/* The eyes, then three whiskers on each side. */}
      <path d="M393.5 553V670M630.5 553V670M161 666H260M263 701H306M174 739H263M757 664H859M714 703H754M757 739H846" />
    </svg>
  );
}
