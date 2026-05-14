import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOffensiveResponseToVehicle1774000000000 implements MigrationInterface {
  name = 'AddOffensiveResponseToVehicle1774000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasOldColumn = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'offensive_response'`
    );

    if (hasOldColumn.length > 0) {
      await queryRunner.query(
        `ALTER TABLE "vehicles" RENAME COLUMN "offensive_response" TO "sentry_offensive_response"`
      );
      await queryRunner.query(
        `ALTER TYPE "vehicles_offensive_response_enum" RENAME TO "vehicles_sentry_offensive_response_enum"`
      );

      await queryRunner.query(
        `UPDATE "vehicles" SET "sentry_offensive_response" = 'HONK' WHERE "sentry_offensive_response" IN ('FLASH', 'FLASH_AND_HONK')`
      );

      await queryRunner.query(
        `CREATE TYPE "vehicles_sentry_offensive_response_enum_v2" AS ENUM('DISABLED', 'HONK')`
      );
      await queryRunner.query(
        `ALTER TABLE "vehicles" ALTER COLUMN "sentry_offensive_response" DROP DEFAULT`
      );
      await queryRunner.query(
        `ALTER TABLE "vehicles" ALTER COLUMN "sentry_offensive_response" TYPE "vehicles_sentry_offensive_response_enum_v2" USING "sentry_offensive_response"::text::"vehicles_sentry_offensive_response_enum_v2"`
      );
      await queryRunner.query(
        `DROP TYPE "vehicles_sentry_offensive_response_enum"`
      );
      await queryRunner.query(
        `ALTER TYPE "vehicles_sentry_offensive_response_enum_v2" RENAME TO "vehicles_sentry_offensive_response_enum"`
      );
      await queryRunner.query(
        `ALTER TABLE "vehicles" ALTER COLUMN "sentry_offensive_response" SET DEFAULT 'DISABLED'`
      );
    } else {
      const hasNewColumn = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'sentry_offensive_response'`
      );

      if (hasNewColumn.length === 0) {
        await queryRunner.query(
          `CREATE TYPE "vehicles_sentry_offensive_response_enum" AS ENUM('DISABLED', 'HONK')`
        );
        await queryRunner.query(
          `ALTER TABLE "vehicles" ADD "sentry_offensive_response" "vehicles_sentry_offensive_response_enum" NOT NULL DEFAULT 'DISABLED'`
        );
      }
    }

    const hasBreakInColumn = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'break_in_offensive_response'`
    );

    if (hasBreakInColumn.length === 0) {
      await queryRunner.query(
        `CREATE TYPE "vehicles_break_in_offensive_response_enum" AS ENUM('DISABLED', 'HONK')`
      );
      await queryRunner.query(
        `ALTER TABLE "vehicles" ADD "break_in_offensive_response" "vehicles_break_in_offensive_response_enum" NOT NULL DEFAULT 'DISABLED'`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicles" DROP COLUMN "break_in_offensive_response"`
    );
    await queryRunner.query(
      `DROP TYPE "vehicles_break_in_offensive_response_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "vehicles" DROP COLUMN "sentry_offensive_response"`
    );
    await queryRunner.query(
      `DROP TYPE "vehicles_sentry_offensive_response_enum"`
    );

    await queryRunner.query(
      `CREATE TYPE "vehicles_offensive_response_enum" AS ENUM('DISABLED', 'FLASH', 'HONK', 'FLASH_AND_HONK')`
    );
    await queryRunner.query(
      `ALTER TABLE "vehicles" ADD "offensive_response" "vehicles_offensive_response_enum" NOT NULL DEFAULT 'DISABLED'`
    );
  }
}