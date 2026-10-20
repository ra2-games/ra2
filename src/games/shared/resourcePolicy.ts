import { withMentalOmegaLauncher } from '../mentalOmega/launcher';
import { withRa2NativeLauncher } from '../ra2/installation';
import { withGameSpeedDefault } from '../gameSpeed';
import type { ResourcePolicy } from '../../resources/contracts';
import type { GameSource } from '../source';
import { withNativeLauncher } from '../yr/installation';

/**
 * Installation-media resources may reuse session snapshots; mutable INI/SAV files must be reread on open.
 * YR .yro files are static maps too; omitting them would cause cross-thread reads on every scan.
 */
const STATIC_RESOURCE = /\.(?:mix|bag|idx|shp|pcx|pal|fnt|csf|aud|vqa|bik|wav|hva|vxl|map|mpr|yrm|yro)$/i;
export const RA2_YR_RESOURCE_POLICY: ResourcePolicy<GameSource> = Object.freeze({
  prepareSource: async (source: GameSource) => {
    const configured = await withGameSpeedDefault(source);
    if (source.game.id === 'mo') return withMentalOmegaLauncher(configured);
    return withRa2NativeLauncher(await withNativeLauncher(configured));
  },
  isSessionStatic: (normalizedPath: string) => STATIC_RESOURCE.test(normalizedPath),
});
