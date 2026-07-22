/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { User } from '../types';

/** Observer role — read-only Discover, no admin surfaces */
export function isViewerUser(user: User | null | undefined): boolean {
  if (!user) return true;
  return user.role === 'observer';
}

export function isAdminUser(user: User | null | undefined): boolean {
  if (!user) return false;
  return user.role === 'super_admin';
}
