import type { VisionMeasurements, VisionReport } from '../model';

export type VisionReportListQuery = {
  cursor?: string;
  limit?: number;
};

export type VisionReportListResult = {
  items: VisionReport[];
  nextCursor: string | null;
};

export type SaveVisionReportInput = {
  examinationDate: string;
  ageYearsAtExamination: number | null;
  centerId: string | null;
  centerName: string;
  measurements: VisionMeasurements;
};

export type VisionCenterOption = {
  id: string;
  name: string;
};

export interface VisionReportApi {
  list(childId: string, query?: VisionReportListQuery): Promise<VisionReportListResult>;
  detail(childId: string, reportId: string): Promise<VisionReport>;
  create(childId: string, input: SaveVisionReportInput): Promise<VisionReport>;
  update(childId: string, reportId: string, input: SaveVisionReportInput): Promise<VisionReport>;
  remove(childId: string, reportId: string): Promise<void>;
  listCenters(): Promise<VisionCenterOption[]>;
}
