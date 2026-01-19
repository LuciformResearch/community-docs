import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";
import { getRagForgeClient } from "@/lib/ragforge";

type Role = "READ" | "WRITE" | "ADMIN";

interface ExtendedUser {
  id?: string;
  role?: Role;
}

// GET - Get project details with stats
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, slug: true, icon: true },
        },
        owner: {
          select: { id: true, username: true, avatar: true },
        },
        documents: {
          select: {
            id: true,
            title: true,
            type: true,
            status: true,
            nodeCount: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Projet non trouvé" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    console.error("Project GET error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la récupération du projet" },
      { status: 500 }
    );
  }
}

// PATCH - Update project
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  categoryId: z.string().cuid().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const { id } = await params;
  const currentUser = session.user as ExtendedUser;

  // Fetch project to check ownership
  const project = await prisma.project.findUnique({
    where: { id },
    select: { ownerId: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Projet non trouvé" }, { status: 404 });
  }

  // Check permission
  const isOwner = currentUser.id === project.ownerId;
  const isAdmin = currentUser.role === "ADMIN";

  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Permission refusée" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

    // If categoryId is provided, verify it exists
    if (data.categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: data.categoryId },
      });
      if (!category) {
        return NextResponse.json(
          { error: "Catégorie non trouvée" },
          { status: 404 }
        );
      }
    }

    const updated = await prisma.project.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.categoryId && { categoryId: data.categoryId }),
      },
      include: {
        category: {
          select: { id: true, name: true, slug: true, icon: true },
        },
        owner: {
          select: { id: true, username: true, avatar: true },
        },
      },
    });

    return NextResponse.json({ project: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Paramètres invalides", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Project update error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la mise à jour" },
      { status: 500 }
    );
  }
}

// DELETE - Delete project and all its documents
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const { id } = await params;
  const currentUser = session.user as ExtendedUser;

  // Fetch project to check ownership
  const project = await prisma.project.findUnique({
    where: { id },
    select: { ownerId: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Projet non trouvé" }, { status: 404 });
  }

  // Check permission
  const isOwner = currentUser.id === project.ownerId;
  const isAdmin = currentUser.role === "ADMIN";

  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Permission refusée" }, { status: 403 });
  }

  try {
    // Delete from RagForge brain (async, don't block response)
    // This deletes all nodes with this projectId in Neo4j
    const client = getRagForgeClient();
    client.deleteProject(id).catch((err: Error) => {
      console.warn("Failed to delete project from Neo4j:", err);
    });

    // Delete project (documents are cascade deleted via Prisma)
    await prisma.project.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Project delete error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la suppression" },
      { status: 500 }
    );
  }
}
