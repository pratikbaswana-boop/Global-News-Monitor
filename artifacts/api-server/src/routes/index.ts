import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import intelligenceRouter from "./intelligence";
import pushRouter from "./push";
import chatRouter from "./chat";
import authRouter from "./auth";
import engagementRouter from "./engagement";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use(intelligenceRouter);
router.use(pushRouter);
router.use(chatRouter);
router.use(authRouter);
router.use(engagementRouter);

export default router;
