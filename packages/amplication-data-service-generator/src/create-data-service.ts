import * as fs from "fs";
import * as path from "path";
import normalize from "normalize-path";

import winston from "winston";
import fg from "fast-glob";

import { formatCode, Module } from "./util/module";
import { getEntityIdToName } from "./util/entity";
import { createDTOModules, createDTOs } from "./resource/create-dtos";
import { createResourcesModules } from "./resource/create-resource";
import { createSwagger } from "./swagger/create-swagger";
import { createAppModule } from "./app-module/create-app-module";
import { createPrismaSchemaModule } from "./prisma/create-prisma-schema-module";
import { defaultLogger } from "./logging";
import { Entity, Role, AppInfo } from "./types";
import { createGrantsModule } from "./create-grants";
import { createUserEntityIfNotExist } from "./user-entity";
import { createSeedModule } from "./seed/create-seed";

const STATIC_DIRECTORY = path.resolve(__dirname, "static");

export async function createDataService(
  entities: Entity[],
  roles: Role[],
  appInfo: AppInfo,
  logger: winston.Logger = defaultLogger
): Promise<Module[]> {
  logger.info("Creating application...");
  const timer = logger.startTimer();
  const staticModules = await readStaticModules(logger);
  const [normalizedEntities, userEntity] = createUserEntityIfNotExist(entities);

  const dynamicModules = await createDynamicModules(
    normalizedEntities,
    userEntity,
    roles,
    appInfo,
    staticModules,
    logger
  );

  timer.done({ message: "Application creation time" });

  const modules = [...staticModules, ...dynamicModules];

  /** @todo make module paths to always use Unix path separator */
  return modules.map((module) => ({
    ...module,
    path: normalize(module.path),
  }));
}

async function createDynamicModules(
  entities: Entity[],
  userEntity: Entity,
  roles: Role[],
  appInfo: AppInfo,
  staticModules: Module[],
  logger: winston.Logger
): Promise<Module[]> {
  const entityIdToName = getEntityIdToName(entities);

  logger.info("Creating resources...");
  const dtos = createDTOs(entities, entityIdToName);
  const dtoModules = createDTOModules(dtos);
  const resourcesModules = await createResourcesModules(
    entities,
    entityIdToName,
    dtos,
    logger
  );

  logger.info("Creating application module...");
  const appModule = await createAppModule(resourcesModules, staticModules);

  logger.info("Creating swagger...");
  const swaggerModule = await createSwagger(appInfo);

  const createdModules = [
    ...resourcesModules,
    ...dtoModules,
    swaggerModule,
    appModule,
  ];

  logger.info("Formatting code...");
  const formattedModules = createdModules.map((module) => ({
    ...module,
    code: formatCode(module.code),
  }));

  logger.info("Creating Prisma schema...");
  const prismaSchemaModule = await createPrismaSchemaModule(
    entities,
    entityIdToName
  );

  logger.info("Creating access control grants...");
  const grantsModule = createGrantsModule(entities, roles);

  logger.info("Creating seed script...");
  const seedModule = await createSeedModule(userEntity);

  return [...formattedModules, prismaSchemaModule, grantsModule, seedModule];
}

async function readStaticModules(logger: winston.Logger): Promise<Module[]> {
  logger.info("Copying static modules...");
  const directory = `${normalize(STATIC_DIRECTORY)}/`;
  const staticModules = await fg(`${directory}**/*`, {
    absolute: false,
    dot: true,
    ignore: ["**.js", "**.js.map", "**.d.ts"],
  });

  return Promise.all(
    staticModules.map(async (module) => ({
      path: module.replace(directory, ""),
      code: await fs.promises.readFile(module, "utf-8"),
    }))
  );
}
