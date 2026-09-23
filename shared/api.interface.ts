export type MaterialTemplateId = 'wis-stage-birthday' | 'birthday-product-hook';

export interface MaterialTemplate {
  id: MaterialTemplateId;
  name: string;
  description: string;
  sourceLabel: string;
  hookDurationSeconds: number;
  hookPath: string;
  thumbnailPath: string;
}
