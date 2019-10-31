///
/// Copyright © 2016-2019 The Thingsboard Authors
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///

import { Injectable } from '@angular/core';
import { Dashboard, DashboardLayoutId } from '@app/shared/models/dashboard.models';
import { EntityAlias, EntityAliasFilter, EntityAliases, EntityAliasInfo } from '@shared/models/alias.models';
import { DatasourceType, Widget, WidgetPosition, WidgetSize } from '@shared/models/widget.models';
import { DashboardUtilsService } from '@core/services/dashboard-utils.service';
import { deepClone } from '@core/utils';
import * as equal from 'deep-equal';
import { UtilsService } from '@core/services/utils.service';
import { Observable, of, throwError } from 'rxjs';
import { map } from 'rxjs/operators';

const WIDGET_ITEM = 'widget_item';
const WIDGET_REFERENCE = 'widget_reference';
const RULE_NODES = 'rule_nodes';

export interface AliasesInfo {
  datasourceAliases: {[datasourceIndex: number]: EntityAliasInfo};
  targetDeviceAliases: {[targetDeviceAliasIndex: number]: EntityAliasInfo};
}

export interface WidgetItem {
  widget: Widget;
  aliasesInfo: AliasesInfo;
  originalSize: WidgetSize;
  originalColumns: number;
}

export interface WidgetReference {
  dashboardId: string;
  sourceState: string;
  sourceLayout: DashboardLayoutId;
  widgetId: string;
  originalSize: WidgetSize;
  originalColumns: number;
}

@Injectable({
  providedIn: 'root'
})
export class ItemBufferService {

  private namespace = 'tbBufferStore';
  private delimiter = '.';

  constructor(private dashboardUtils: DashboardUtilsService,
              private utils: UtilsService) {}

  public prepareWidgetItem(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId, widget: Widget): WidgetItem {
    const aliasesInfo: AliasesInfo = {
      datasourceAliases: {},
      targetDeviceAliases: {}
    };
    const originalColumns = this.getOriginalColumns(dashboard, sourceState, sourceLayout);
    const originalSize = this.getOriginalSize(dashboard, sourceState, sourceLayout, widget);
    if (widget.config && dashboard.configuration
      && dashboard.configuration.entityAliases) {
      let entityAlias: EntityAlias;
      if (widget.config.datasources) {
        for (let i = 0; i < widget.config.datasources.length; i++) {
          const datasource = widget.config.datasources[i];
          if (datasource.type === DatasourceType.entity && datasource.entityAliasId) {
            entityAlias = dashboard.configuration.entityAliases[datasource.entityAliasId];
            if (entityAlias) {
              aliasesInfo.datasourceAliases[i] = this.prepareAliasInfo(entityAlias);
            }
          }
        }
      }
      if (widget.config.targetDeviceAliasIds) {
        for (let i = 0; i < widget.config.targetDeviceAliasIds.length; i++) {
          const targetDeviceAliasId = widget.config.targetDeviceAliasIds[i];
          if (targetDeviceAliasId) {
            entityAlias = dashboard.configuration.entityAliases[targetDeviceAliasId];
            if (entityAlias) {
              aliasesInfo.targetDeviceAliases[i] = this.prepareAliasInfo(entityAlias);
            }
          }
        }
      }
    }
    return {
      widget,
      aliasesInfo,
      originalSize,
      originalColumns
    };
  }

  public copyWidget(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId, widget: Widget): void {
    const widgetItem = this.prepareWidgetItem(dashboard, sourceState, sourceLayout, widget);
    this.storeSet(WIDGET_ITEM, JSON.stringify(widgetItem));
  }

  public copyWidgetReference(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId, widget: Widget): void {
    const widgetReference = this.prepareWidgetReference(dashboard, sourceState, sourceLayout, widget);
    this.storeSet(WIDGET_REFERENCE, JSON.stringify(widgetReference));
  }

  public hasWidget(): boolean {
    return this.storeHas(WIDGET_ITEM);
  }

  public canPasteWidgetReference(dashboard: Dashboard, state: string, layout: DashboardLayoutId): boolean {
    const widgetReferenceJson = this.storeGet(WIDGET_REFERENCE);
    if (widgetReferenceJson) {
      const widgetReference: WidgetReference = JSON.parse(widgetReferenceJson);
      if (widgetReference.dashboardId === dashboard.id.id) {
        if ((widgetReference.sourceState !== state || widgetReference.sourceLayout !== layout)
          && dashboard.configuration.widgets[widgetReference.widgetId]) {
          return true;
        }
      }
    }
    return false;
  }

  public pasteWidget(targetDashboard: Dashboard, targetState: string,
                     targetLayout: DashboardLayoutId, position: WidgetPosition,
                     onAliasesUpdateFunction: () => void): Observable<Widget> {
    const widgetItemJson = this.storeGet(WIDGET_ITEM);
    if (widgetItemJson) {
      const widgetItem: WidgetItem = JSON.parse(widgetItemJson);
      const widget = widgetItem.widget;
      const aliasesInfo = widgetItem.aliasesInfo;
      const originalColumns = widgetItem.originalColumns;
      const originalSize = widgetItem.originalSize;
      let targetRow = -1;
      let targetColumn = -1;
      if (position) {
        targetRow = position.row;
        targetColumn = position.column;
      }
      widget.id = this.utils.guid();
      return this.addWidgetToDashboard(targetDashboard, targetState,
                                targetLayout, widget, aliasesInfo,
                                onAliasesUpdateFunction, originalColumns,
                                originalSize, targetRow, targetColumn).pipe(
        map(() => widget)
      );
    } else {
      return throwError('Failed to read widget from buffer!');
    }
  }

  public pasteWidgetReference(targetDashboard: Dashboard, targetState: string,
                              targetLayout: DashboardLayoutId, position: WidgetPosition): Observable<Widget> {
    const widgetReferenceJson = this.storeGet(WIDGET_REFERENCE);
    if (widgetReferenceJson) {
      const widgetReference: WidgetReference = JSON.parse(widgetReferenceJson);
      const widget = targetDashboard.configuration.widgets[widgetReference.widgetId];
      if (widget) {
        const originalColumns = widgetReference.originalColumns;
        const originalSize = widgetReference.originalSize;
        let targetRow = -1;
        let targetColumn = -1;
        if (position) {
          targetRow = position.row;
          targetColumn = position.column;
        }
        return this.addWidgetToDashboard(targetDashboard, targetState,
          targetLayout, widget, null,
          null, originalColumns,
          originalSize, targetRow, targetColumn).pipe(
          map(() => widget)
        );
      } else {
        return throwError('Failed to read widget reference from buffer!');
      }
    } else {
      return throwError('Failed to read widget reference from buffer!');
    }
  }

  public addWidgetToDashboard(dashboard: Dashboard, targetState: string,
                              targetLayout: DashboardLayoutId, widget: Widget,
                              aliasesInfo: AliasesInfo,
                              onAliasesUpdateFunction: () => void,
                              originalColumns: number,
                              originalSize: WidgetSize,
                              row: number,
                              column: number): Observable<Dashboard> {
    let theDashboard: Dashboard;
    if (dashboard) {
      theDashboard = dashboard;
    } else {
      theDashboard = {};
    }
    theDashboard = this.dashboardUtils.validateAndUpdateDashboard(theDashboard);
    let callAliasUpdateFunction = false;
    if (aliasesInfo) {
      const newEntityAliases = this.updateAliases(theDashboard, widget, aliasesInfo);
      const aliasesUpdated = !equal(newEntityAliases, theDashboard.configuration.entityAliases);
      if (aliasesUpdated) {
        theDashboard.configuration.entityAliases = newEntityAliases;
        if (onAliasesUpdateFunction) {
          callAliasUpdateFunction = true;
        }
      }
    }
    this.dashboardUtils.addWidgetToLayout(theDashboard, targetState, targetLayout, widget,
                                          originalColumns, originalSize, row, column);
    if (callAliasUpdateFunction) {
      onAliasesUpdateFunction();
    }
    return of(theDashboard);
  }

  private getOriginalColumns(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId): number {
    let originalColumns = 24;
    let gridSettings = null;
    const state = dashboard.configuration.states[sourceState];
    const layoutCount = Object.keys(state.layouts).length;
    if (state) {
      const layout = state.layouts[sourceLayout];
      if (layout) {
        gridSettings = layout.gridSettings;

      }
    }
    if (gridSettings &&
      gridSettings.columns) {
      originalColumns = gridSettings.columns;
    }
    originalColumns = originalColumns * layoutCount;
    return originalColumns;
  }

  private getOriginalSize(dashboard: Dashboard, sourceState: string, sourceLayout: DashboardLayoutId, widget: Widget): WidgetSize {
    const layout = dashboard.configuration.states[sourceState].layouts[sourceLayout];
    const widgetLayout = layout.widgets[widget.id];
    return {
      sizeX: widgetLayout.sizeX,
      sizeY: widgetLayout.sizeY
    };
  }

  private prepareAliasInfo(entityAlias: EntityAlias): EntityAliasInfo {
    return {
      alias: entityAlias.alias,
      filter: entityAlias.filter
    };
  }

  private prepareWidgetReference(dashboard: Dashboard, sourceState: string,
                                 sourceLayout: DashboardLayoutId, widget: Widget): WidgetReference {
    const originalColumns = this.getOriginalColumns(dashboard, sourceState, sourceLayout);
    const originalSize = this.getOriginalSize(dashboard, sourceState, sourceLayout, widget);
    return {
      dashboardId: dashboard.id.id,
      sourceState,
      sourceLayout,
      widgetId: widget.id,
      originalSize,
      originalColumns
    };
  }

  private updateAliases(dashboard: Dashboard, widget: Widget, aliasesInfo: AliasesInfo): EntityAliases {
    const entityAliases = deepClone(dashboard.configuration.entityAliases);
    let aliasInfo: EntityAliasInfo;
    let newAliasId: string;
    for (const datasourceIndexStr of Object.keys(aliasesInfo.datasourceAliases)) {
      const datasourceIndex = Number(datasourceIndexStr);
      aliasInfo = aliasesInfo.datasourceAliases[datasourceIndex];
      newAliasId = this.getEntityAliasId(entityAliases, aliasInfo);
      widget.config.datasources[datasourceIndex].entityAliasId = newAliasId;
    }
    for (const targetDeviceAliasIndexStr of Object.keys(aliasesInfo.targetDeviceAliases)) {
      const targetDeviceAliasIndex = Number(targetDeviceAliasIndexStr);
      aliasInfo = aliasesInfo.targetDeviceAliases[targetDeviceAliasIndex];
      newAliasId = this.getEntityAliasId(entityAliases, aliasInfo);
      widget.config.targetDeviceAliasIds[targetDeviceAliasIndex] = newAliasId;
    }
    return entityAliases;
  }

  private isEntityAliasEqual(alias1: EntityAliasInfo, alias2: EntityAliasInfo): boolean {
    return equal(alias1.filter, alias2.filter);
  }

  private getEntityAliasId(entityAliases: EntityAliases, aliasInfo: EntityAliasInfo): string {
    let newAliasId: string;
    for (const aliasId of Object.keys(entityAliases)) {
      if (this.isEntityAliasEqual(entityAliases[aliasId], aliasInfo)) {
        newAliasId = aliasId;
        break;
      }
    }
    if (!newAliasId) {
      const newAliasName = this.createEntityAliasName(entityAliases, aliasInfo.alias);
      newAliasId = this.utils.guid();
      entityAliases[newAliasId] = {id: newAliasId, alias: newAliasName, filter: aliasInfo.filter};
    }
    return newAliasId;
  }

  private createEntityAliasName(entityAliases: EntityAliases, alias: string): string {
    let c = 0;
    let newAlias = alias;
    let unique = false;
    while (!unique) {
      unique = true;
      for (const entAliasId of Object.keys(entityAliases)) {
        const entAlias = entityAliases[entAliasId];
        if (newAlias === entAlias.alias) {
          c++;
          newAlias = alias + c;
          unique = false;
        }
      }
    }
    return newAlias;
  }

  private storeSet(key: string, elem: any) {
    localStorage.setItem(this.getNamespacedKey(key), JSON.stringify(elem));
  }

  private storeGet(key: string): any {
    let obj = null;
    const saved = localStorage.getItem(this.getNamespacedKey(key));
    try {
      if (typeof saved === 'undefined' || saved === 'undefined') {
        obj = undefined;
      } else {
        obj = JSON.parse(saved);
      }
    } catch (e) {
      this.storeRemove(key);
    }
    return obj;
  }

  private storeHas(key: string): boolean {
    const saved = localStorage.getItem(this.getNamespacedKey(key));
    return typeof saved !== 'undefined' && saved !== 'undefined' && saved !== null;
  }

  private storeRemove(key: string) {
    localStorage.removeItem(this.getNamespacedKey(key));
  }

  private getNamespacedKey(key: string): string {
    return [this.namespace, key].join(this.delimiter);
  }
}
