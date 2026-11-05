import React, { useId } from 'react';
import type { VizSpec } from '../agui/types';
import { Card } from './Card';

const APP_TITLES: Record<string, string> = {
  Correlation: 'Correlation Plot',
  OncoMatrix: 'OncoMatrix',
  DE: 'Differential Gene Expression',
};

/**
 * Where the pinned native viewer mounts. Marked `data-orion-viz` so Esc inside it
 * belongs to ProteinPaint's menus, not to Stop.
 */
export const VizCardPlaceholder = ({ spec }: { spec: VizSpec }) => {
  const titleId = useId();
  return (
    <Card
      titleId={titleId}
      title={`${APP_TITLES[spec.appId] ?? spec.appId} · ${spec.launcher}`}
      data-orion-viz
    >
      <p className="text-sm">The native viewer mounts here, pinned to the inputs of its cited step.</p>
      <p className="text-xs">
        Cites {spec.citesSteps.join(', ')} · pinned inputs{' '}
        <span className="font-mono">{spec.pinnedHash.slice(0, 12)}</span>
      </p>
    </Card>
  );
};
