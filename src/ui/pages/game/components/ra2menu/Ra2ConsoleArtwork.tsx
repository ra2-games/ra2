import { useId } from 'react';
import { CLIENT_URL, GAME_TITLE } from '../../branding';
import { RADAR_LAND_PATHS, RADAR_DETAIL_PATHS, RADAR_CONTACTS } from './radarMapPaths';
import { WORDMARK_GLYPHS, WORDMARK_LETTERS } from './wordmarkPaths';
import './consoleArtwork.css';

// Proportions are based on measured chassis/display landmarks in the retained reference.
// The side curves stay bowed instead of becoming long vertical straight segments.
const collar =
  'M162 14 H466 C485 14 550 14 570 40 C604 78 605 157 605 253 C606 351 606 413 596 470 C592 488 588 516 574 532 C551 557 490 557 461 557 H158 C135 557 71 557 48 532 C34 516 24 488 20 470 C12 413 10 351 10 253 C10 157 14 78 48 40 C71 14 135 14 162 14 Z';
const collarFace =
  'M163 19 H465 C484 19 546 19 566 43 C599 80 600 158 600 253 C601 349 601 412 592 468 C588 486 585 512 570 528 C548 552 491 552 461 552 H159 C136 552 75 552 52 528 C38 512 30 486 24 468 C17 412 15 349 15 253 C15 158 19 79 52 43 C75 19 136 19 163 19 Z';
const glass =
  'M170 35 H445 C518 35 550 49 565 87 C580 125 582 183 582 253 C582 331 578 389 569 440 C564 490 535 524 443 532 H172 C80 524 52 490 47 440 C40 389 36 331 36 253 C36 183 39 125 54 87 C69 49 99 35 170 35 Z';

/** Independently authored SVG equipment with static procedural material filters. */
export function Ra2ConsoleArtwork() {
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = (name: string) => `${prefix}-${name}`;
  const paint = (name: string) => `url(#${id(name)})`;
  return (
    <svg
      className="ra2-console-art"
      viewBox="0 0 800 600"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id('steel')} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#77787a" />
          <stop offset=".06" stopColor="#929395" />
          <stop offset=".095" stopColor="#bfc0c2" />
          <stop offset=".125" stopColor="#88898b" />
          <stop offset=".32" stopColor="#797a7c" />
          <stop offset=".54" stopColor="#848587" />
          <stop offset=".72" stopColor="#68696b" />
          <stop offset=".94" stopColor="#999a9c" />
          <stop offset="1" stopColor="#606164" />
        </linearGradient>
        <linearGradient id={id('machined-edge')} x1="0" y1="0" x2="1" y2=".7">
          <stop stopColor="#f0f0ef" />
          <stop offset=".18" stopColor="#d8d8d7" />
          <stop offset=".43" stopColor="#878888" />
          <stop offset=".6" stopColor="#454646" />
          <stop offset=".82" stopColor="#c5c5c4" />
          <stop offset="1" stopColor="#eeeeec" />
        </linearGradient>
        <radialGradient id={id('collar-edge-reflection')} cx=".14" cy=".86" r=".82">
          <stop stopColor="#edeeec" stopOpacity=".9" />
          <stop offset=".38" stopColor="#d3d4d2" stopOpacity=".6" />
          <stop offset=".72" stopColor="#b1b2b0" stopOpacity=".22" />
          <stop offset="1" stopColor="#b1b2b0" stopOpacity=".08" />
        </radialGradient>
        <linearGradient id={id('chassis-tone')} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#000" stopOpacity=".04" />
          <stop offset=".2" stopColor="#000" stopOpacity="0" />
          <stop offset=".65" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".16" />
        </linearGradient>
        <linearGradient id={id('top-reflection')} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="55">
          <stop stopColor="#f5f5f3" stopOpacity=".32" />
          <stop offset=".08" stopColor="#eeeeec" stopOpacity=".2" />
          <stop offset=".3" stopColor="#e0e0de" stopOpacity=".08" />
          <stop offset="1" stopColor="#e0e0de" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id('top-lip')}>
          <stop stopColor="#bdbdbf" />
          <stop offset=".12" stopColor="#f7f7f5" />
          <stop offset=".32" stopColor="#dededd" />
          <stop offset=".6" stopColor="#bbbbbc" />
          <stop offset=".86" stopColor="#efefed" />
          <stop offset="1" stopColor="#b4b4b6" />
        </linearGradient>
        <linearGradient id={id('edge')} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#e5e8e4" />
          <stop offset=".22" stopColor="#9c9e9d" />
          <stop offset=".5" stopColor="#2e2f30" />
          <stop offset=".86" stopColor="#c1c3c0" />
          <stop offset="1" stopColor="#686a69" />
        </linearGradient>
        <linearGradient id={id('collar-face')} x1="0" y1="0" x2=".16" y2="1">
          <stop stopColor="#101011" />
          <stop offset=".22" stopColor="#1c1c1e" />
          <stop offset=".52" stopColor="#242426" />
          <stop offset=".78" stopColor="#1c1c1e" />
          <stop offset="1" stopColor="#171719" />
        </linearGradient>
        <linearGradient id={id('collar-tone')} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#000" stopOpacity=".55" />
          <stop offset=".22" stopColor="#000" stopOpacity=".25" />
          <stop offset=".55" stopColor="#000" stopOpacity=".2" />
          <stop offset=".78" stopColor="#000" stopOpacity=".22" />
          <stop offset="1" stopColor="#000" stopOpacity=".2" />
        </linearGradient>
        <filter id={id('rounded-collar')} x="-3%" y="-3%" width="106%" height="106%" colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="saturate" values="0" result="neutral" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="profile" />
          <feDiffuseLighting
            in="profile"
            surfaceScale="9"
            diffuseConstant=".7"
            lightingColor="#bfc0c2"
            result="rounding"
          >
            <feDistantLight azimuth="235" elevation="42" />
          </feDiffuseLighting>
          <feComposite in="rounding" in2="SourceAlpha" operator="in" result="shading" />
          <feBlend in="neutral" in2="shading" mode="soft-light" result="body" />
          <feSpecularLighting
            in="profile"
            surfaceScale="9"
            specularConstant=".17"
            specularExponent="16"
            lightingColor="#bcbec0"
            result="reflection"
          >
            <fePointLight x="100" y="-120" z="170" />
          </feSpecularLighting>
          <feComposite in="reflection" in2="SourceAlpha" operator="in" result="lip" />
          <feBlend in="body" in2="lip" mode="screen" />
        </filter>
        <linearGradient id={id('curved-steel')} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#47494b" />
          <stop offset=".07" stopColor="#bdc0c1" />
          <stop offset=".19" stopColor="#787b7e" />
          <stop offset=".43" stopColor="#585b5e" />
          <stop offset=".7" stopColor="#393c3f" />
          <stop offset=".93" stopColor="#7a7d80" />
          <stop offset="1" stopColor="#2e3236" />
        </linearGradient>
        <linearGradient id={id('rack-steel')} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#444446" />
          <stop offset=".075" stopColor="#d2d2d3" />
          <stop offset=".14" stopColor="#939395" />
          <stop offset=".34" stopColor="#646466" />
          <stop offset=".67" stopColor="#39393b" />
          <stop offset=".91" stopColor="#7c7c7e" />
          <stop offset="1" stopColor="#303032" />
        </linearGradient>
        <radialGradient id={id('terminal-reflection')} cx=".065" cy=".08" r=".67">
          <stop stopColor="#f7f6f3" stopOpacity=".28" />
          <stop offset=".28" stopColor="#deddda" stopOpacity=".09" />
          <stop offset="1" stopColor="#deddda" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('rack-fold')} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#d5d1d2" />
          <stop offset=".25" stopColor="#8c888a" />
          <stop offset=".62" stopColor="#4b474a" />
          <stop offset="1" stopColor="#171518" />
        </linearGradient>
        <linearGradient id={id('bezel-edge')} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#c9c7c8" />
          <stop offset=".2" stopColor="#696768" />
          <stop offset=".5" stopColor="#1a181a" />
          <stop offset=".85" stopColor="#626061" />
          <stop offset="1" stopColor="#a7a3a5" />
        </linearGradient>
        <linearGradient id={id('rack-plate')} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#999e9f" />
          <stop offset=".08" stopColor="#727879" />
          <stop offset=".3" stopColor="#565d5f" />
          <stop offset=".5" stopColor="#444c4e" />
          <stop offset=".7" stopColor="#565d5f" />
          <stop offset=".92" stopColor="#727879" />
          <stop offset="1" stopColor="#999e9f" />
        </linearGradient>
        <linearGradient id={id('rack-side')} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#0a0a0b" />
          <stop offset=".22" stopColor="#606062" />
          <stop offset=".35" stopColor="#b0b0b1" />
          <stop offset=".48" stopColor="#3d3d3f" />
          <stop offset=".8" stopColor="#19191b" />
          <stop offset="1" stopColor="#0b0b0c" />
        </linearGradient>
        <radialGradient id={id('face-reflection')} cx=".09" cy=".025" r=".66">
          <stop stopColor="#eceee5" stopOpacity=".075" />
          <stop offset=".4" stopColor="#d9ddd5" stopOpacity=".02" />
          <stop offset="1" stopColor="#d9ddd5" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('radar')} cx=".65" cy=".37" r=".75">
          <stop stopColor="#290200" />
          <stop offset=".5" stopColor="#120100" />
          <stop offset="1" stopColor="#030101" />
        </radialGradient>
        <radialGradient id={id('vignette')}>
          <stop offset=".52" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".65" />
        </radialGradient>
        <radialGradient id={id('sweep')} gradientUnits="userSpaceOnUse" cx="308" cy="253" r="270">
          <stop stopColor="#e51908" stopOpacity="0" />
          <stop offset=".18" stopColor="#e51908" stopOpacity=".06" />
          <stop offset=".5" stopColor="#f21c09" stopOpacity=".34" />
          <stop offset=".82" stopColor="#f5210c" stopOpacity=".65" />
          <stop offset=".96" stopColor="#ef1706" stopOpacity=".2" />
          <stop offset="1" stopColor="#ef1706" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('signal-bloom')}>
          <stop stopColor="#ff3b12" stopOpacity=".7" />
          <stop offset=".25" stopColor="#f6220a" stopOpacity=".34" />
          <stop offset="1" stopColor="#e60a00" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('terrain-depth')} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#fff" />
          <stop offset=".55" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".83" stopColor="#fff" stopOpacity=".45" />
          <stop offset="1" stopColor="#fff" stopOpacity=".08" />
        </linearGradient>
        <mask id={id('terrain-depth-mask')} maskUnits="userSpaceOnUse" x="25" y="25" width="570" height="525">
          <rect x="25" y="25" width="570" height="525" fill={paint('terrain-depth')} />
        </mask>
        <radialGradient id={id('terrain-body')} cx=".7" cy=".3" r=".85">
          <stop stopColor="#560700" />
          <stop offset=".55" stopColor="#300300" />
          <stop offset="1" stopColor="#130100" />
        </radialGradient>
        <linearGradient id={id('detail-ink')} gradientUnits="userSpaceOnUse" x1="40" y1="80" x2="550" y2="480">
          <stop stopColor="#c51a0a" />
          <stop offset=".28" stopColor="#ff3618" />
          <stop offset=".58" stopColor="#bd1608" />
          <stop offset="1" stopColor="#f52c11" />
        </linearGradient>
        <filter id={id('cast')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency=".34"
            numOctaves="4"
            seed="31"
            stitchTiles="stitch"
            result="etch"
          />
          <feColorMatrix in="etch" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 0 0 0 0" result="height" />
          <feDiffuseLighting
            in="height"
            surfaceScale=".12"
            diffuseConstant="1.2"
            lightingColor="#bfc0ba"
            result="relief"
          >
            <feDistantLight azimuth="235" elevation="35" />
          </feDiffuseLighting>
          <feComponentTransfer in="relief">
            <feFuncA type="linear" slope=".28" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" result="surface" />
          <feBlend in="SourceGraphic" in2="surface" mode="soft-light" result="base" />
          <feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="2" seed="17" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".1" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" result="grain" />
          <feBlend in="base" in2="grain" mode="soft-light" />
        </filter>
        <filter id={id('molded')} x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="17" result="grain" />
          <feColorMatrix in="grain" type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".035" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" result="finish" />
          <feBlend in="SourceGraphic" in2="finish" mode="soft-light" result="material" />
          <feGaussianBlur in="SourceAlpha" stdDeviation=".75" result="profile" />
          <feSpecularLighting
            in="profile"
            surfaceScale="5"
            specularConstant=".5"
            specularExponent="30"
            lightingColor="#d6d9d4"
            result="reflection"
          >
            <fePointLight x="75" y="-45" z="150" />
          </feSpecularLighting>
          <feComposite in="reflection" in2="SourceAlpha" operator="in" result="rim" />
          <feBlend in="material" in2="rim" mode="screen" />
        </filter>
        <filter id={id('rack-etch')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".28 .48" numOctaves="3" seed="47" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".14" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" result="grain" />
          <feBlend in="SourceGraphic" in2="grain" mode="soft-light" />
        </filter>
        <filter id={id('rack-finish')} x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" seed="31" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope=".04" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" result="grain" />
          <feBlend in="SourceGraphic" in2="grain" mode="soft-light" result="material" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="profile" />
          <feSpecularLighting
            in="profile"
            surfaceScale="3"
            specularConstant=".17"
            specularExponent="20"
            lightingColor="#d3d8ce"
            result="shine"
          >
            <fePointLight x="635" y="10" z="120" />
          </feSpecularLighting>
          <feComposite in="shine" in2="SourceAlpha" operator="in" result="rim" />
          <feBlend in="material" in2="rim" mode="screen" />
        </filter>
        <filter id={id('glow')} x="-15%" y="-15%" width="130%" height="130%">
          <feGaussianBlur stdDeviation=".65" />
        </filter>
        <clipPath id={id('glass')}>
          <path d={glass} />
        </clipPath>
        <clipPath id={id('map-fragments')}>
          {RADAR_LAND_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </clipPath>
        <filter id={id('map-edge')} x="-1%" y="-1%" width="102%" height="102%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius=".6" result="outline" />
          <feComposite in="outline" in2="SourceAlpha" operator="out" result="edge" />
          <feFlood floodColor="#ff3216" floodOpacity=".85" result="ink" />
          <feComposite in="ink" in2="edge" operator="in" result="rim" />
          <feGaussianBlur in="rim" stdDeviation="1.1" result="edge-glow" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="edge-glow" />
            <feMergeNode in="rim" />
          </feMerge>
        </filter>
        <filter id={id('map-grain')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".3" numOctaves="3" seed="29" />
          <feColorMatrix values=".7 0 0 0 0  0 0 0 0 .005  0 0 0 0 .002  1 0 0 0 -.15" />
        </filter>
        <filter id={id('map-relief')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".035 .05" numOctaves="3" seed="17" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" />
          <feComponentTransfer result="contours">
            <feFuncA
              type="discrete"
              tableValues="0 0 0 0 0 0 0 0 0 .6 0 0 .45 0 0 .7 0 0 .5 0 0 .35 0 0 0 0 0 0 0 0 0 0"
            />
          </feComponentTransfer>
          <feTurbulence type="fractalNoise" baseFrequency=".008 .012" numOctaves="2" seed="31" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2 0 0 0 -.45" result="relief-strength" />
          <feComposite in="contours" in2="relief-strength" operator="in" result="relief" />
          <feFlood floodColor="#ec2910" />
          <feComposite in2="relief" operator="in" />
        </filter>
        <radialGradient id={id('glass-reflection')} cx=".78" cy=".04" r=".53">
          <stop stopColor="#d7d7cc" stopOpacity=".055" />
          <stop offset=".34" stopColor="#a8ada7" stopOpacity=".025" />
          <stop offset="1" stopColor="#c3c7bf" stopOpacity="0" />
        </radialGradient>

        <pattern id={id('crt-lines')} width="3" height="2" patternUnits="userSpaceOnUse">
          <path d="M0 1 H3" stroke="#000" strokeOpacity=".1" strokeWidth=".35" />
        </pattern>
        <g id={id('screw')}>
          <circle r="2.7" fill={paint('curved-steel')} stroke="#111b22" strokeWidth=".7" />
          <path d="M-1.7 1.2 L1.7 -1.2" stroke="#111820" strokeWidth=".85" />
          <path d="M-1.6 1.6 L1.8 -.8" stroke="#bfc9bf" strokeOpacity=".35" strokeWidth=".4" />
        </g>
      </defs>
      <rect
        x=".7"
        y=".7"
        width="614.3"
        height="564.5"
        rx="5"
        fill={paint('steel')}
        filter={paint('molded')}
        stroke={paint('edge')}
        strokeWidth="1.5"
      />
      <rect x="1.5" y="1.5" width="613" height="563" rx="4" fill={paint('chassis-tone')} />
      <rect x="1.5" y="1.5" width="613" height="563" rx="4" fill={paint('face-reflection')} />
      <rect x="1.5" y="1.5" width="613" height="55" rx="4" fill={paint('top-reflection')} />
      <path
        d="M1.8 17 V6 Q1.8 1.8 6 1.8 H609 Q614 1.8 614 6 V17"
        fill="none"
        stroke={paint('top-lip')}
        strokeWidth="1.2"
      />
      <rect
        x="3"
        y="3"
        width="609.8"
        height="559.5"
        rx="3"
        fill="none"
        stroke={paint('machined-edge')}
        strokeOpacity=".62"
        strokeWidth=".7"
      />
      <path d={collar} fill="#252527" stroke="#414143" strokeWidth=".7" />
      <path d={collar} fill="none" stroke={paint('collar-edge-reflection')} strokeWidth="1.35" />
      <g filter={paint('rounded-collar')}>
        <path d={`${collarFace} ${glass}`} fill={paint('collar-face')} fillRule="evenodd" filter={paint('cast')} />
      </g>
      <path d={`${collarFace} ${glass}`} fill={paint('collar-tone')} fillRule="evenodd" />
      <path d={`${collarFace} ${glass}`} fill="none" stroke="#737476" strokeWidth=".5" opacity=".18" />
      <path d={glass} fill="none" stroke="#030403" strokeWidth="3.5" opacity=".8" />
      <path className="console-glass" d={glass} fill={paint('radar')} stroke="#030608" strokeWidth="2.5" />
      <g clipPath={paint('glass')}>
        <g mask={paint('terrain-depth-mask')}>
          <g fill={paint('terrain-body')} filter={paint('map-edge')}>
            {RADAR_LAND_PATHS.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          <g clipPath={paint('map-fragments')}>
            <rect x="25" y="25" width="570" height="525" filter={paint('map-grain')} opacity=".16" />
            <rect x="25" y="25" width="570" height="525" filter={paint('map-relief')} opacity=".65" />
            <g fill="none" stroke={paint('detail-ink')} strokeWidth=".45" strokeLinecap="round">
              {RADAR_DETAIL_PATHS.map((d, i) => (
                <path key={i} d={d} opacity={i % 3 === 0 ? 0.55 : 0.28} />
              ))}
            </g>
          </g>
        </g>
        <g fill="none" stroke="#d82514" strokeWidth=".65">
          {[42, 82, 124, 172, 216, 262].map((r, i) => (
            <circle
              key={r}
              cx="308"
              cy="253"
              r={r}
              opacity={i % 2 ? '.68' : '.4'}
              strokeDasharray={i === 2 ? '1.5 2.5' : undefined}
            />
          ))}
          <path d="M32 253 H585 M308 25 V548" opacity=".4" />
          {Array.from({ length: 72 }, (_, i) => {
            const a = (i * Math.PI) / 36;
            const r = i % 3 === 0 ? 271 : 266;
            return (
              <path
                key={i}
                d={`M${308 + Math.cos(a) * 257},${253 + Math.sin(a) * 257}L${308 + Math.cos(a) * r},${253 + Math.sin(a) * r}`}
                opacity=".5"
              />
            );
          })}
        </g>
        <g className="radar-sweep">
          <g fill={paint('sweep')} filter={paint('glow')}>
            {Array.from({ length: 64 }, (_, i) => {
              const front = Math.atan2(199, 173);
              const a = front - 0.6 + (i / 64) * 0.6;
              const b = a + 0.6 / 64 + 0.001;
              return (
                <path
                  key={i}
                  d={`M308 253 L${308 + Math.cos(a) * 262} ${253 + Math.sin(a) * 262} A262 262 0 0 1 ${308 + Math.cos(b) * 262} ${253 + Math.sin(b) * 262} Z`}
                  opacity={Math.pow((i + 1) / 64, 2.5) * 0.72}
                />
              );
            })}
          </g>
          <path d="M308 253 L481 452" stroke="#f5250b" strokeWidth="1.4" filter={paint('glow')} opacity=".65" />
          <path d="M308 253 L481 452" stroke="#ff4220" strokeWidth=".4" opacity=".72" />
        </g>
        <g fill="none" stroke="#a31b0f" strokeWidth=".45" opacity=".6">
          <circle cx="308" cy="253" r="5" />
          <path d="M300 253 H304 M312 253 H316 M308 245 V249 M308 257 V261" />
        </g>
        <g stroke="#bb2518" strokeWidth=".35" opacity=".35">
          {Array.from({ length: 26 }, (_, i) => {
            const v = 80 + i * 18;
            return <path key={i} d={`M${v} 250 V256 M305 ${v} H311`} />;
          })}
        </g>
        <g fill="#bc2417" fontFamily="monospace" fontSize="4.5" textAnchor="middle" opacity=".68">
          {Array.from({ length: 12 }, (_, i) => {
            const angle = ((i * 30 - 90) * Math.PI) / 180;
            return (
              <text key={i} x={308 + Math.cos(angle) * 246} y={255 + Math.sin(angle) * 246}>
                {String(i * 30).padStart(3, '0')}
              </text>
            );
          })}
        </g>
        <rect x="25" y="25" width="570" height="525" fill={paint('crt-lines')} />
        <rect x="25" y="25" width="570" height="525" fill={paint('glass-reflection')} />
        <rect x="25" y="25" width="570" height="525" fill={paint('vignette')} />
        {RADAR_CONTACTS.map(({ x, y, strength, radius, bloom }, i) => {
          const phase =
            ((Math.atan2(y - 253, x - 308) - Math.atan2(199, 173) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
          return (
            <g key={i} className="radar-contact" style={{ animationDelay: `calc(${phase - 1} * var(--radar-period))` }}>
              <g opacity={strength}>
                <circle cx={x} cy={y} r={bloom} fill={paint('signal-bloom')} />
                <path
                  d={`M${x - 5} ${y} H${x + 5} M${x} ${y - 3} V${y + 3}`}
                  stroke="#ff4918"
                  strokeWidth=".8"
                  opacity=".85"
                />
                <circle cx={x} cy={y} r={radius} fill="#ff4220" filter={paint('glow')} />
                <circle cx={x} cy={y} r={radius * 0.42} fill="#ffd0a0" />
              </g>
            </g>
          );
        })}
      </g>
      <g className="console-badge">
        <defs>
          <linearGradient id={id('identity-gold')} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#f3e3ac" />
            <stop offset=".2" stopColor="#ddc67d" />
            <stop offset=".55" stopColor="#a48b4b" />
            <stop offset=".82" stopColor="#d3ba72" />
            <stop offset="1" stopColor="#76643d" />
          </linearGradient>
          <linearGradient id={id('identity-red')} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#ea3020" />
            <stop offset=".22" stopColor="#ce2112" />
            <stop offset=".65" stopColor="#aa170b" />
            <stop offset="1" stopColor="#77100a" />
          </linearGradient>
          {Object.entries(WORDMARK_GLYPHS).map(([letter, d]) => (
            <path id={id(`letter-${letter}`)} d={d} fillRule="evenodd" key={letter} />
          ))}
        </defs>
        <defs>
          <linearGradient id={id('badge-alloy')} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#dbdcd6" />
            <stop offset=".12" stopColor="#b0b2b0" />
            <stop offset=".24" stopColor="#7c8180" />
            <stop offset=".38" stopColor="#b8bab1" />
            <stop offset=".55" stopColor="#676d6a" />
            <stop offset=".74" stopColor="#93998f" />
            <stop offset="1" stopColor="#c7c7b5" />
          </linearGradient>
          <filter id={id('badge-brushed')} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency=".015 .8" numOctaves="2" seed="19" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="linear" slope=".16" />
            </feComponentTransfer>
            <feComposite in2="SourceGraphic" operator="in" result="grain" />
            <feBlend in="SourceGraphic" in2="grain" mode="soft-light" />
          </filter>
          <clipPath id={id('badge-vanes')}>
            <path d="M80 203 H538 L525 245 L308 314 L92 245 Z" />
          </clipPath>
        </defs>
        <path
          d="M69 176 L87 146 L200 167 L211 190 H285 L296 194 H320 L331 190 H405 L417 167 L530 146 L549 176 L530 250 L308 324 L89 250 Z"
          fill="#000"
          opacity=".9"
          transform="translate(0 6)"
        />
        <path
          d="M80 203 H538 L525 245 L308 314 L92 245 Z"
          fill={paint('badge-alloy')}
          filter={paint('badge-brushed')}
          stroke="#afb3a8"
          strokeWidth="1.5"
        />
        <g clipPath={paint('badge-vanes')} fill="none">
          {Array.from({ length: 27 }, (_, row) => (
            <g key={row}>
              <path
                d={`M78 ${181 + row * 4.8} L308 ${223 + row * 4.8} L540 ${181 + row * 4.8}`}
                stroke="#4e5751"
                strokeWidth="1.3"
              />
              <path
                d={`M78 ${182.4 + row * 4.8} L308 ${224.4 + row * 4.8} L540 ${182.4 + row * 4.8}`}
                stroke="#d7d8c5"
                strokeWidth=".55"
              />
            </g>
          ))}
        </g>
        <path
          d="M71 175 L88 147 L199 167 L210 190 L270 201 L256 212 L84 203 Z"
          fill={paint('badge-alloy')}
          filter={paint('badge-brushed')}
          stroke="#cdd0c5"
          strokeWidth="1.4"
        />
        <path
          d="M547 175 L529 147 L418 167 L407 190 L347 201 L362 212 L535 203 Z"
          fill={paint('badge-alloy')}
          filter={paint('badge-brushed')}
          stroke="#cdd0c5"
          strokeWidth="1.4"
        />
        <path
          d="M85 169 L94 156 L194 176 L204 196 L249 205 M533 169 L523 156 L423 176 L413 196 L370 205"
          fill="none"
          stroke="#eeefe3"
          strokeWidth="1.8"
        />
        <path
          d="M99 164 L135 171 L146 183 L192 191 M518 164 L482 171 L471 183 L425 191"
          fill="none"
          stroke="#878e89"
          strokeWidth="1.4"
        />
        <path d="M83 199 L241 213 M535 199 L375 213" stroke="#4d5550" strokeWidth="2" />
        <path
          d="M296 194 H320 L370 300 L308 318 L246 300 Z"
          fill={paint('badge-alloy')}
          filter={paint('badge-brushed')}
          stroke="#dedfc9"
          strokeWidth="1.3"
        />
        <path d="M300 200 H316 L362 297 L308 311 L254 297 Z" fill="#4e5751" stroke="#858c7b" strokeWidth="1" />
        <path
          d="M303 204 H313 L355 293 L308 305 L261 293 Z"
          fill={paint('badge-alloy')}
          filter={paint('badge-brushed')}
        />
        <g fillRule="evenodd" strokeLinejoin="bevel">
          {WORDMARK_LETTERS.map(({ glyph, x, y, sx, sy }, i) => (
            <use
              key={i}
              href={`#${id(`letter-${glyph}`)}`}
              transform={`translate(${x + 1.4} ${y + 3}) scale(${sx} ${sy})`}
              fill="#2a0b04"
              stroke="#150501"
              strokeWidth="3.2"
            />
          ))}
          {WORDMARK_LETTERS.map(({ glyph, x, y, sx, sy }, i) => (
            <use
              key={i}
              href={`#${id(`letter-${glyph}`)}`}
              transform={`translate(${x} ${y}) scale(${sx} ${sy})`}
              fill={paint('identity-red')}
              stroke={paint('identity-gold')}
              strokeWidth="3"
              paintOrder="stroke fill"
            />
          ))}
          {WORDMARK_LETTERS.map(({ glyph, x, y, sx, sy }, i) => (
            <use
              key={i}
              href={`#${id(`letter-${glyph}`)}`}
              transform={`translate(${x} ${y}) scale(${sx} ${sy})`}
              fill="none"
              stroke="#d9bc7e"
              strokeWidth=".45"
            />
          ))}
          <g className="console-title">
            <title>{GAME_TITLE}</title>
          </g>
        </g>
      </g>
      <rect x="1" y="568" width="614" height="31" rx="2" fill="#030608" stroke={paint('edge')} strokeWidth="1.5" />
      <rect x="5" y="572" width="606" height="23" fill="#010203" stroke="#2a3034" strokeWidth=".7" />
      <rect x="617" y="1" width="182" height="598" fill="#141414" stroke="#383638" strokeWidth=".7" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M620 181 C622 184 622 190 624 197 C626 217 621 252 623 283 S621 372 624 422 S622 519 625 580"
          stroke="#481d1b"
          strokeWidth="2.6"
        />
        <path
          d="M620 181 C622 184 622 190 624 197 C626 217 621 252 623 283 S621 372 624 422 S622 519 625 580"
          stroke="#89504a"
          strokeWidth=".55"
          opacity=".55"
        />
        <path
          d="M794 178 C792 185 791 191 791 198 C790 222 794 253 792 295 S794 403 792 465 S795 548 791 584"
          stroke="#572622"
          strokeWidth="2"
        />
      </g>
      {Array.from({ length: 9 }, (_, i) => {
        const y = 205 + i * 42;
        return (
          <g key={i}>
            <path d={`M617 ${y} H625 V${y + 25} H617 Z`} fill="#292528" stroke="#090809" strokeWidth=".6" />
            <path
              d={`M618 ${y + 1} H624 M618 ${y + 8} H624 M618 ${y + 17} H624 M618 ${y + 24} H624`}
              stroke={paint('machined-edge')}
              strokeWidth=".7"
            />
            <path d={`M794 ${y} H799 V${y + 25} H794 Z`} fill="#292528" stroke="#090809" strokeWidth=".6" />
            <path d={`M794 ${y + 2} H799 M794 ${y + 11} H799 M794 ${y + 23} H799`} stroke="#888385" strokeWidth=".65" />
          </g>
        );
      })}
      <path d="M625 193 H793 V587 H625 Z" fill="#161416" stroke={paint('machined-edge')} strokeWidth=".8" />
      <path d="M627 195 H791 V584 H627 Z" fill={paint('rack-plate')} filter={paint('rack-etch')} />
      <path d="M621 195 H627 V583 L622 591 Z" fill={paint('rack-side')} stroke="#161617" strokeWidth=".6" />
      <path d="M797 195 H791 V583 L796 591 Z" fill={paint('rack-side')} stroke="#161617" strokeWidth=".6" />
      {Array.from({ length: 9 }, (_, i) => {
        const y = 199 + i * 42;
        return (
          <g key={i}>
            <rect x="627" y={y} width="164" height="42" fill={paint('rack-plate')} filter={paint('rack-etch')} />
            <path d={`M627 ${y - 0.8} H791`} stroke="#171517" strokeWidth="1.6" />
            <path d={`M627 ${y} H791 L790 ${y + 3.4} H628 Z`} fill={paint('rack-fold')} />
            <path d={`M627 ${y} H791`} stroke="#d5d1d2" strokeWidth=".45" />
            <path d={`M628 ${y + 1} H790`} stroke="#8c878a" strokeWidth=".35" opacity=".6" />
            <path d={`M628 ${y + 38} H790 V${y + 41} H628 Z`} fill="#1d2527" opacity=".65" />
            <path d={`M628 ${y + 3.4} V${y + 38}`} stroke="#adb3b2" strokeWidth=".85" opacity=".65" />
            <path d={`M790 ${y + 3.4} V${y + 38}`} stroke="#adb3b2" strokeWidth=".85" opacity=".65" />
          </g>
        );
      })}
      <path d="M627 577 H791" stroke="#c3bebf" strokeWidth=".8" />
      <path d="M625 581 H793 V596 H625 Z" fill={paint('rack-steel')} stroke={paint('edge')} strokeWidth=".65" />
      <path d="M627 595 H791" fill="none" stroke="#6d2018" strokeWidth="1" />
      <path
        d="M637 7 H781 Q795 15 798 36 V149 Q796 174 777 185 Q708 202 638 183 Q619 174 619 151 V37 Q621 15 637 7 Z"
        fill={paint('rack-steel')}
        filter={paint('rack-finish')}
        stroke={paint('machined-edge')}
        strokeWidth="1"
      />
      <path
        d="M637 7 H781 Q795 15 798 36 V149 Q796 174 777 185 Q708 202 638 183 Q619 174 619 151 V37 Q621 15 637 7 Z"
        fill={paint('terminal-reflection')}
      />
      <path d="M627 33 H791 V155 H627 Z" fill={paint('bezel-edge')} stroke="#282628" strokeWidth=".65" />
      <rect x="630" y="36" width="159" height="118" rx="1.5" fill="#020202" stroke="#a9a5a7" strokeWidth=".7" />
      <path
        d="M637 159 Q707 144 783 158 Q777 181 709 187 Q648 183 637 159 Z"
        fill={paint('rack-steel')}
        filter={paint('rack-finish')}
        stroke="#c4bfc1"
        strokeWidth=".9"
      />
      <path d="M638 159 Q707 145 782 158" fill="none" stroke="#f0eded" strokeWidth=".65" />
      <path d="M646 179 Q709 196 777 177" fill="none" stroke="#57241f" strokeWidth="1.1" />
      <path
        d="M635 187 H784 L791 194 H628 Z"
        fill={paint('rack-steel')}
        stroke={paint('machined-edge')}
        strokeWidth=".8"
      />
      <g fill="#222022" stroke="#9c9799" strokeWidth=".6">
        <path d="M628 186 L634 182 L637 191 H628 Z" />
        <path d="M785 182 L791 187 V191 H783 Z" />
      </g>
      <use href={`#${id('screw')}`} transform="translate(632 186) scale(.8)" />
      <use href={`#${id('screw')}`} transform="translate(787 186) scale(.8)" />
      <path d="M629 193 H790" stroke="#070607" strokeWidth="2" />
      <path d="M628 197 H791" stroke="#d6d3d4" strokeWidth=".8" />
      <path
        d="M638 1 H780 Q783 1 783 5 V19 Q711 31 639 20 Q636 19 636 16 V5 Q636 1 638 1 Z"
        fill="#0a090a"
        stroke={paint('machined-edge')}
        strokeWidth="1.1"
      />
      <path d="M640 4 H779 V17 Q710 25 640 18 Z" fill="#010101" stroke="#353233" strokeWidth=".65" />
      <text
        className="console-domain"
        x="709.5"
        y="16"
        textAnchor="middle"
        fill="#d4b574"
        fontFamily="Arial, sans-serif"
        fontSize="11"
        fontWeight="700"
      >
        {CLIENT_URL}
      </text>
      <g fill="none" stroke="#dededc" strokeWidth=".45" opacity=".38">
        <path d="M5 112 H10 M5 118 H8 M5 449 H10 M5 455 H8" />
        <path d="M605 112 H611 M608 118 H611 M605 449 H611 M608 455 H611" />
      </g>
      {[
        [8, 8],
        [607, 8],
        [8, 559],
        [607, 559],
        [7, 143],
        [7, 424],
        [608, 143],
        [608, 424],
        [620, 5],
        [796, 5],
        [620, 592],
        [796, 592],
      ].map(([x, y], i) => (
        <use key={i} href={`#${id('screw')}`} x={x} y={y} />
      ))}
    </svg>
  );
}
