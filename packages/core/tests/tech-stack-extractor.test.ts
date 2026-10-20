/**
 * Unit tests: Dynamic Tech Stack Extractor (MOD-02)
 *
 * Verifies dynamic tech stack parsing, CLI scaffold templates, and confidence scoring.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractTechStackSchema,
  deriveProjectSlug,
} from '../dist/autonomous/index.js';

describe('Dynamic Tech Stack Extractor (MOD-02)', () => {
  it('extracts Next.js with App Router, TypeScript, Tailwind, and Shadcn', () => {
    const spec = `
# Randevu Sistemi
Modern bir randevu takip platformu.

## Teknoloji Yığını
- Çatı: Next.js 14 (App Router)
- Dil: TypeScript
- Stil: Tailwind CSS
- UI: Shadcn UI
- Paket Yöneticisi: pnpm
- Veritabanı: Supabase
`;

    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'randevu-sistemi');
    assert.equal(schema.runtime, 'node');
    assert.equal(schema.language, 'typescript');
    assert.equal(schema.framework, 'nextjs');
    assert.equal(schema.routerOrArchitecture, 'app-router');
    assert.equal(schema.styling, 'tailwind');
    assert.equal(schema.uiComponents, 'shadcn-ui');
    assert.equal(schema.databaseOrm, 'supabase');
    assert.equal(schema.packageManager, 'pnpm');
    assert.ok(schema.scaffoldCommand?.includes('create-next-app@latest'));
    assert.ok(schema.scaffoldCommand?.includes('--use-pnpm'));
    assert.ok(schema.scaffoldCommand?.includes('--yes'));
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts Vite + React (TypeScript)', () => {
    const spec = `
# Admin Dashboard
Single page web application using Vite and React with TypeScript.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'admin-dashboard');
    assert.equal(schema.runtime, 'node');
    assert.equal(schema.language, 'typescript');
    assert.equal(schema.framework, 'vite-react');
    assert.equal(schema.scaffoldCommand, 'npm create vite@latest ./ -- --template react-ts');
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts NestJS backend with pnpm', () => {
    const spec = `
# Microservice Gateway
Built with NestJS and pnpm.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'microservice-gateway');
    assert.equal(schema.runtime, 'node');
    assert.equal(schema.language, 'typescript');
    assert.equal(schema.framework, 'nestjs');
    assert.ok(schema.scaffoldCommand?.includes('@nestjs/cli new'));
    assert.ok(schema.scaffoldCommand?.includes('--package-manager pnpm'));
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts FastAPI with Poetry', () => {
    const spec = `
# ML Inference API
A high performance REST API built with FastAPI and poetry.
Database: SQLAlchemy.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'ml-inference-api');
    assert.equal(schema.runtime, 'python');
    assert.equal(schema.language, 'python');
    assert.equal(schema.framework, 'fastapi');
    assert.equal(schema.packageManager, 'poetry');
    assert.equal(schema.databaseOrm, 'sqlalchemy');
    assert.ok(schema.scaffoldCommand?.includes('poetry init -n'));
    assert.ok(schema.scaffoldCommand?.includes('fastapi'));
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts Rust application with Cargo', () => {
    const spec = `
# Packet Filter
Network tool built with Rust and Cargo.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'packet-filter');
    assert.equal(schema.runtime, 'rust');
    assert.equal(schema.language, 'rust');
    assert.equal(schema.packageManager, 'cargo');
    assert.equal(schema.scaffoldCommand, 'cargo init --vcs none .');
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts Go project', () => {
    const spec = `
# Payment Worker
Background processor using Go 1.22 with Gin.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'payment-worker');
    assert.equal(schema.runtime, 'go');
    assert.equal(schema.language, 'go');
    assert.equal(schema.framework, 'gin');
    assert.equal(schema.scaffoldCommand, 'go mod init payment-worker');
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts Flutter project', () => {
    const spec = `
# Crypto Wallet
Mobile app built with Flutter and Dart.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.projectName, 'crypto-wallet');
    assert.equal(schema.language, 'dart');
    assert.equal(schema.framework, 'flutter');
    assert.ok(schema.scaffoldCommand?.includes('flutter create'));
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('extracts PlatformIO embedded project', () => {
    const spec = `
# Sensor Hub
IoT node built with PlatformIO for ESP32.
`;
    const schema = extractTechStackSchema(spec);
    assert.equal(schema.framework, 'platformio');
    assert.equal(schema.scaffoldCommand, 'pio project init --board esp32dev');
    assert.ok(schema.confidenceScore >= 0.9);
  });

  it('handles custom project name override and deriveProjectSlug fallback', () => {
    const custom = extractTechStackSchema('Some spec without heading', 'custom-name');
    assert.equal(custom.projectName, 'custom-name');

    const fallbackSlug = deriveProjectSlug('No heading text', 'my-default');
    assert.equal(fallbackSlug, 'my-default');

    const markdownSlug = deriveProjectSlug('# Special & Unique Name! (v2)');
    assert.equal(markdownSlug, 'special-unique-name-v2');
  });

  it('detects comprehensive multi-target monorepo architecture (Next.js Web + Flutter Mobile + NestJS API)', () => {
    const multiSpec = `
# Yıldız Bayan Kuaförü ERP & Randevu Sistemi
Kuaför salonu için uçtan uca randevu, kasa ve sadakat yönetim sistemi.

## Mimari ve Platformlar
- Web Yönetim Paneli: Next.js 14 App Router, Tailwind CSS, Shadcn UI
- Müşteri Mobil Uygulaması: Flutter & Dart (Android & iOS)
- Arka Plan API & Mikroservis: NestJS with TypeScript, PostgreSQL
- Ortak Kütüphane: Shared TypeScript types and components
- Çalışma Alanı: pnpm workspaces with Turborepo
`;

    const schema = extractTechStackSchema(multiSpec);
    assert.equal(schema.isMonorepo, true);
    assert.equal(schema.workspaceType, 'monorepo');
    assert.equal(schema.workspaceManager, 'pnpm');
    assert.ok(schema.targets.length >= 3, `Expected at least 3 targets, got ${schema.targets.length}`);

    const webTarget = schema.targets.find((t) => t.type === 'web');
    assert.ok(webTarget, 'Must have web target');
    assert.equal(webTarget.framework, 'nextjs');
    assert.equal(webTarget.path, 'apps/web');

    const mobileTarget = schema.targets.find((t) => t.type === 'mobile');
    assert.ok(mobileTarget, 'Must have mobile target');
    assert.equal(mobileTarget.framework, 'flutter');
    assert.equal(mobileTarget.path, 'apps/mobile');

    const backendTarget = schema.targets.find((t) => t.type === 'backend');
    assert.ok(backendTarget, 'Must have backend target');
    assert.equal(backendTarget.framework, 'nestjs');
    assert.equal(backendTarget.path, 'apps/api');

    // Must NOT run single destructive root create-next-app in monorepo
    assert.equal(schema.scaffoldCommand?.includes('create-next-app@latest ./'), false);
    assert.ok(schema.scaffoldCommand?.includes('pnpm') || schema.scaffoldCommand?.includes('turbo'));
  });

  it('detects monorepo when explicit workspace keywords are present even with single framework', () => {
    const workspaceSpec = `
# Modular Platform
Monorepo workspace powered by Turborepo and pnpm-workspace.yaml.
Core web frontend built with Next.js.
`;
    const schema = extractTechStackSchema(workspaceSpec);
    assert.equal(schema.isMonorepo, true);
    assert.equal(schema.workspaceType, 'monorepo');
    assert.equal(schema.workspaceManager, 'pnpm');
  });
});
