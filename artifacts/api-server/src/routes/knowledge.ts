import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, knowledgeTable } from "@workspace/db";
import {
  ListKnowledgeItemsQueryParams,
  UpdateKnowledgeItemParams,
  UpdateKnowledgeItemBody,
  DeleteKnowledgeItemParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/knowledge", async (req, res): Promise<void> => {
  const params = ListKnowledgeItemsQueryParams.safeParse(req.query);
  let items = await db.select().from(knowledgeTable).orderBy(knowledgeTable.category);

  if (params.success && params.data.category) {
    items = items.filter((i) => i.category === params.data.category);
  }

  res.json(items);
});

router.post("/knowledge", async (req, res): Promise<void> => {
  const body = req.body;
  if (!body.title || !body.category || !body.content) {
    res.status(400).json({ error: "title, category, and content are required" });
    return;
  }

  const [item] = await db.insert(knowledgeTable).values({
    title: body.title,
    category: body.category,
    content: body.content,
    modelName: body.modelName ?? null,
    fileUrl: body.fileUrl ?? null,
    isActive: true,
  }).returning();

  res.status(201).json(item);
});

router.patch("/knowledge/:id", async (req, res): Promise<void> => {
  const params = UpdateKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateKnowledgeItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [item] = await db.update(knowledgeTable)
    .set(body.data)
    .where(eq(knowledgeTable.id, params.data.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(item);
});

router.delete("/knowledge/:id", async (req, res): Promise<void> => {
  const params = DeleteKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(knowledgeTable).where(eq(knowledgeTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
