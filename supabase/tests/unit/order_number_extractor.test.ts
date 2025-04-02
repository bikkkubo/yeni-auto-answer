import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { extractOrderNumber } from "../../functions/channelio-webhook-handler/index.ts";

Deno.test("extractOrderNumber - 正常系", async (t) => {
    await t.step("基本的な注文番号の抽出", () => {
        const result = extractOrderNumber("注文番号はyeni-12345です");
        assertEquals(result, "yeni-12345");
    });

    await t.step("#付きの注文番号の抽出", () => {
        const result = extractOrderNumber("注文番号は#yeni-12345です");
        assertEquals(result, "yeni-12345");
    });

    await t.step("大文字小文字を区別しない", () => {
        const result = extractOrderNumber("注文番号はYENI-12345です");
        assertEquals(result, "YENI-12345");
    });

    await t.step("文字列の途中に注文番号がある場合", () => {
        const result = extractOrderNumber("こちらの商品についてyeni-12345の注文状況を確認したいです");
        assertEquals(result, "yeni-12345");
    });
});

Deno.test("extractOrderNumber - 異常系", async (t) => {
    await t.step("注文番号が含まれていない場合", () => {
        const result = extractOrderNumber("注文番号はありません");
        assertEquals(result, null);
    });

    await t.step("空の文字列の場合", () => {
        const result = extractOrderNumber("");
        assertEquals(result, null);
    });

    await t.step("nullの場合", () => {
        const result = extractOrderNumber(null as unknown as string);
        assertEquals(result, null);
    });

    await t.step("不正な形式の注文番号", () => {
        const result = extractOrderNumber("yeni12345");
        assertEquals(result, null);
    });

    await t.step("数字のない注文番号", () => {
        const result = extractOrderNumber("yeni-abc");
        assertEquals(result, null);
    });
}); 