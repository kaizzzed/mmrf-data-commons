import React, { useState } from 'react';
import { Button, NativeSelect, TextInput } from '@mantine/core';
import type { DeMethod, DeThresholds, Editable, EditPlanAction, ScopeChoice } from '../agui/types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An edit as the plan card makes it; the caller adds `action` and, for scope, the cohort context. */
export type PlanEdit = DistributiveOmit<EditPlanAction, 'action' | 'cohortContext'>;

/** A scope the plan card offers, with the edit value that switches to it. */
export interface ScopeOption {
  label: string;
  choice: ScopeChoice;
}

export const METHOD_LABELS: Record<DeMethod, string> = {
  wilcoxon: 'Wilcoxon rank-sum',
  edgeR: 'edgeR',
  limma: 'limma',
};

export const sameScope = (a: ScopeChoice, b: ScopeChoice): boolean =>
  a.source === b.source && (a.cohortName ?? null) === (b.cohortName ?? null) && (a.ledgerRef ?? null) === (b.ledgerRef ?? null);

const scopeKey = (choice: ScopeChoice): string => JSON.stringify([choice.source, choice.cohortName ?? null, choice.ledgerRef ?? null]);

const ApplyButton = ({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) => (
  <Button type="button" variant="default" size="xs" disabled={disabled} onClick={onClick} aria-label={`Apply ${label}`}>
    Apply
  </Button>
);

const ScopeEditor = ({
  editable,
  options,
  disabled,
  onEdit,
}: {
  editable: Extract<Editable, { field: 'scope' }>;
  options: readonly ScopeOption[];
  disabled: boolean;
  onEdit: (edit: PlanEdit) => void;
}) => {
  const choices = options.filter((o) => !sameScope(o.choice, editable.value));
  const [key, setKey] = useState(choices[0] ? scopeKey(choices[0].choice) : '');
  const picked = choices.find((o) => scopeKey(o.choice) === key);
  if (choices.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <NativeSelect
        label={editable.label}
        value={key}
        onChange={(event) => setKey(event.currentTarget.value)}
        data={choices.map((o) => ({ value: scopeKey(o.choice), label: o.label }))}
      />
      <ApplyButton
        label={editable.label}
        disabled={disabled || !picked}
        onClick={() => picked && onEdit({ field: 'scope', value: picked.choice })}
      />
    </div>
  );
};

const MethodEditor = ({
  editable,
  disabled,
  onEdit,
}: {
  editable: Extract<Editable, { field: 'method' }>;
  disabled: boolean;
  onEdit: (edit: PlanEdit) => void;
}) => {
  const [method, setMethod] = useState<DeMethod>(editable.value);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <NativeSelect
        label={editable.label}
        value={method}
        onChange={(event) => setMethod(event.currentTarget.value as DeMethod)}
        data={(Object.keys(METHOD_LABELS) as DeMethod[]).map((m) => ({ value: m, label: METHOD_LABELS[m] }))}
      />
      <ApplyButton
        label={editable.label}
        disabled={disabled || method === editable.value}
        onClick={() => onEdit({ field: 'method', value: method })}
      />
    </div>
  );
};

const parseNumber = (text: string): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const TopNEditor = ({
  editable,
  disabled,
  onEdit,
}: {
  editable: Extract<Editable, { field: 'topN' }>;
  disabled: boolean;
  onEdit: (edit: PlanEdit) => void;
}) => {
  const [text, setText] = useState(String(editable.value));
  const value = parseNumber(text);
  const valid = value !== null && Number.isInteger(value) && value >= 1 && value <= editable.max;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextInput
        label={editable.label}
        description={`1 to ${editable.max}`}
        type="number"
        min={1}
        max={editable.max}
        step={1}
        value={text}
        error={valid ? undefined : `A whole number from 1 to ${editable.max}`}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <ApplyButton
        label={editable.label}
        disabled={disabled || !valid || value === editable.value}
        onClick={() => value !== null && onEdit({ field: 'topN', value })}
      />
    </div>
  );
};

const ThresholdsEditor = ({
  editable,
  disabled,
  onEdit,
}: {
  editable: Extract<Editable, { field: 'thresholds' }>;
  disabled: boolean;
  onEdit: (edit: PlanEdit) => void;
}) => {
  const [p, setP] = useState(String(editable.value.pValueCutoff));
  const [type, setType] = useState<DeThresholds['pValueType']>(editable.value.pValueType);
  const [fc, setFc] = useState(String(editable.value.foldChangeCutoff));
  const pValue = parseNumber(p);
  const fold = parseNumber(fc);
  const pValid = pValue !== null && pValue > 0 && pValue <= 1;
  const fcValid = fold !== null && fold >= 0;
  const next: DeThresholds | null =
    pValid && fcValid && pValue !== null && fold !== null
      ? { pValueCutoff: pValue, pValueType: type, foldChangeCutoff: fold }
      : null;
  const unchanged =
    !!next &&
    next.pValueCutoff === editable.value.pValueCutoff &&
    next.pValueType === editable.value.pValueType &&
    next.foldChangeCutoff === editable.value.foldChangeCutoff;
  return (
    <fieldset className="flex flex-wrap items-end gap-2">
      <legend className="text-sm font-medium">{editable.label}</legend>
      <TextInput
        label="p-value cutoff"
        type="number"
        step="any"
        value={p}
        error={pValid ? undefined : 'Above 0 and at most 1'}
        onChange={(event) => setP(event.currentTarget.value)}
      />
      <NativeSelect
        label="p-value type"
        value={type}
        onChange={(event) => setType(event.currentTarget.value as DeThresholds['pValueType'])}
        data={[
          { value: 'adjusted', label: 'Adjusted' },
          { value: 'original', label: 'Original' },
        ]}
      />
      <TextInput
        label="|log2FC| cutoff"
        type="number"
        step="any"
        value={fc}
        error={fcValid ? undefined : '0 or more'}
        onChange={(event) => setFc(event.currentTarget.value)}
      />
      <ApplyButton
        label={editable.label}
        disabled={disabled || !next || unchanged}
        onClick={() => next && onEdit({ field: 'thresholds', value: next })}
      />
    </fieldset>
  );
};

export interface PlanEditsProps {
  editable: readonly Editable[];
  scopeOptions: readonly ScopeOption[];
  disabled: boolean;
  onEdit: (edit: PlanEdit) => void;
}

/**
 * The plan's editable settings (plan.editable): each edit makes plan version n+1 without a model
 * call. A value equal to the current one changes nothing, so Apply waits for a change. Cohort
 * names are renamed on the confirmation card.
 */
export const PlanEdits = ({ editable, scopeOptions, disabled, onEdit }: PlanEditsProps) => (
  <div className="flex flex-col gap-3">
    {editable.map((item, i) => {
      switch (item.field) {
        case 'scope':
          return <ScopeEditor key={i} editable={item} options={scopeOptions} disabled={disabled} onEdit={onEdit} />;
        case 'method':
          return <MethodEditor key={i} editable={item} disabled={disabled} onEdit={onEdit} />;
        case 'topN':
          return <TopNEditor key={i} editable={item} disabled={disabled} onEdit={onEdit} />;
        case 'thresholds':
          return <ThresholdsEditor key={i} editable={item} disabled={disabled} onEdit={onEdit} />;
        default:
          return null;
      }
    })}
  </div>
);
