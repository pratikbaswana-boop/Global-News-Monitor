import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import intelligenceRouter from "./intelligence";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use(intelligenceRouter);
router.use(pushRouter);

export default router;
