import numpy as np
from typing import Dict, List, Tuple, Optional
from collections import deque


def build_adjacency(positions: np.ndarray, normals: np.ndarray,
                    k_neighbors: int = 10, distance_threshold: Optional[float] = None) -> Tuple[List[List[int]], np.ndarray]:
    n = len(positions)
    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(positions)
        distances, indices = tree.query(positions, k=k_neighbors + 1)
        distances = distances[:, 1:]
        indices = indices[:, 1:]
    except ImportError:
        print("scipy not available, using naive neighbor search")
        indices = np.zeros((n, k_neighbors), dtype=np.int64)
        distances = np.zeros((n, k_neighbors), dtype=np.float64)
        for i in range(n):
            diffs = positions - positions[i]
            dists = np.linalg.norm(diffs, axis=1)
            sorted_idx = np.argsort(dists)
            indices[i] = sorted_idx[1:k_neighbors + 1]
            distances[i] = dists[indices[i]]

    if distance_threshold is None:
        all_dists = distances.flatten()
        distance_threshold = np.percentile(all_dists, 90) * 1.5

    adjacency: List[List[int]] = [[] for _ in range(n)]
    edge_weights: Dict[Tuple[int, int], float] = {}

    if normals is not None and normals.shape == positions.shape:
        norm_similarities = np.abs(np.sum(normals[:, None, :] * normals[indices], axis=2))
    else:
        norm_similarities = np.ones_like(distances) * 0.5

    dist_max = distances.max() if distances.max() > 0 else 1.0

    for i in range(n):
        for j_idx in range(k_neighbors):
            j = int(indices[i, j_idx])
            if j >= n:
                continue
            d = distances[i, j_idx]
            if d > distance_threshold:
                continue
            dist_term = 1.0 - (d / dist_max)
            normal_term = norm_similarities[i, j_idx]
            weight = 0.6 * dist_term + 0.4 * normal_term
            weight = max(0.01, min(1.0, weight))
            adjacency[i].append(j)
            edge_weights[(min(i, j), max(i, j))] = weight

    return adjacency, distances


def region_growing_segmentation(positions: List[List[float]],
                                 normals: List[List[float]],
                                 seed_points: Dict[str, List[int]],
                                 k_neighbors: int = 10,
                                 similarity_threshold: float = 0.35) -> Dict[str, List[int]]:
    positions_arr = np.array(positions, dtype=np.float64)
    normals_arr = np.array(normals, dtype=np.float64) if normals else None
    n = len(positions_arr)

    adjacency, _ = build_adjacency(positions_arr, normals_arr, k_neighbors=k_neighbors)

    labels: List[Optional[str]] = [None] * n
    label_confidence: np.ndarray = np.zeros(n, dtype=np.float64)
    queue: deque = deque()

    for label, seeds in seed_points.items():
        for seed in seeds:
            if 0 <= seed < n:
                labels[seed] = label
                label_confidence[seed] = 1.0
                queue.append(seed)

    visited = [False] * n
    for seed_list in seed_points.values():
        for s in seed_list:
            if 0 <= s < n:
                visited[s] = True

    iterations = 0
    max_iterations = n * 2
    while queue and iterations < max_iterations:
        iterations += 1
        current = queue.popleft()
        current_label = labels[current]
        if current_label is None:
            continue

        for neighbor in adjacency[current]:
            if visited[neighbor]:
                continue
            seed_pos = None
            for s in seed_points.get(current_label, []):
                if 0 <= s < n:
                    seed_pos = positions_arr[s]
                    break
            if seed_pos is None:
                continue

            dist = np.linalg.norm(positions_arr[neighbor] - positions_arr[current])
            if normals_arr is not None:
                normal_sim = abs(np.dot(normals_arr[neighbor], normals_arr[current]))
            else:
                normal_sim = 0.5

            dist_to_any_seed = min(
                np.linalg.norm(positions_arr[neighbor] - positions_arr[s])
                for s in seed_points.get(current_label, []) if 0 <= s < n
            )
            spatial_decay = np.exp(-dist_to_any_seed * 8)
            confidence = 0.35 * (1.0 - min(1.0, dist * 15)) + 0.35 * normal_sim + 0.3 * spatial_decay
            confidence = max(0.0, min(1.0, confidence))

            if confidence >= similarity_threshold:
                labels[neighbor] = current_label
                label_confidence[neighbor] = confidence
                visited[neighbor] = True
                queue.append(neighbor)

    result: Dict[str, List[int]] = {label: [] for label in seed_points.keys()}
    for i in range(n):
        if labels[i] is not None and i not in [s for seeds in seed_points.values() for s in seeds]:
            result[labels[i]].append(i)

    for label in result:
        if not result[label]:
            result[label] = list(seed_points.get(label, []))

    return result


def multi_label_graph_cut(positions: List[List[float]],
                          normals: List[List[float]],
                          seed_points: Dict[str, List[int]],
                          k_neighbors: int = 8,
                          spatial_weight: float = 0.6,
                          normal_weight: float = 0.4) -> Dict[str, List[int]]:
    positions_arr = np.array(positions, dtype=np.float64)
    normals_arr = np.array(normals, dtype=np.float64) if normals else None
    n = len(positions_arr)

    label_names = list(seed_points.keys())
    num_labels = len(label_names)

    if num_labels == 0:
        return {}
    if num_labels == 1:
        return region_growing_segmentation(positions, normals, seed_points, k_neighbors=k_neighbors)

    adjacency, distances = build_adjacency(positions_arr, normals_arr, k_neighbors=k_neighbors)

    seed_to_label: Dict[int, int] = {}
    for label_idx, label_name in enumerate(label_names):
        for seed in seed_points[label_name]:
            if 0 <= seed < n:
                seed_to_label[seed] = label_idx

    unary: np.ndarray = np.full((n, num_labels), 0.5, dtype=np.float64)
    for seed_idx, label_idx in seed_to_label.items():
        for l in range(num_labels):
            if l == label_idx:
                unary[seed_idx, l] = 0.0
            else:
                unary[seed_idx, l] = 10.0

    for i in range(n):
        if i in seed_to_label:
            continue
        for l, label_name in enumerate(label_names):
            seeds = seed_points[label_name]
            if not seeds:
                unary[i, l] = 1.0
                continue
            valid_seeds = [s for s in seeds if 0 <= s < n]
            if not valid_seeds:
                unary[i, l] = 1.0
                continue
            min_dist = min(np.linalg.norm(positions_arr[i] - positions_arr[s]) for s in valid_seeds)
            unary[i, l] = np.exp(-min_dist * 6) * (-1) + 0.5
            if normals_arr is not None:
                max_norm_sim = max(
                    abs(np.dot(normals_arr[i], normals_arr[s])) for s in valid_seeds
                )
                unary[i, l] -= max_norm_sim * 0.3

    labels = np.argmin(unary, axis=1)

    for seed_idx, label_idx in seed_to_label.items():
        labels[seed_idx] = label_idx

    dist_max_global = distances.max() if distances.size > 0 and distances.max() > 0 else 1.0

    for _ in range(3):
        changed = 0
        for i in range(n):
            if i in seed_to_label:
                continue
            best_label = labels[i]
            best_energy = unary[i, best_label]

            neighbor_votes: Dict[int, float] = {}
            for neighbor in adjacency[i]:
                nl = int(labels[neighbor])
                if nl not in neighbor_votes:
                    neighbor_votes[nl] = 0.0
                d = np.linalg.norm(positions_arr[i] - positions_arr[neighbor])
                dist_w = 1.0 - min(1.0, d / dist_max_global)
                nw = dist_w
                if normals_arr is not None:
                    nw = spatial_weight * dist_w + normal_weight * abs(np.dot(normals_arr[i], normals_arr[neighbor]))
                neighbor_votes[nl] += nw

            for candidate_label, vote_weight in neighbor_votes.items():
                pairwise_cost = 1.0 / (vote_weight + 0.1) if candidate_label != best_label else 0.0
                total_energy = unary[i, candidate_label] + pairwise_cost * 0.4
                if total_energy < best_energy:
                    best_energy = total_energy
                    best_label = candidate_label

            if best_label != labels[i]:
                labels[i] = best_label
                changed += 1
        if changed == 0:
            break

    result: Dict[str, List[int]] = {name: [] for name in label_names}
    for i in range(n):
        if i not in seed_to_label:
            result[label_names[int(labels[i])]].append(i)

    for label_name, seeds in seed_points.items():
        for s in seeds:
            if s not in result[label_name]:
                result[label_name].append(s)

    return result


def run_segmentation(positions: List[List[float]],
                     normals: List[List[float]],
                     seed_points: Dict[str, List[int]],
                     method: str = "auto",
                     **kwargs) -> Dict[str, List[int]]:
    num_labels = len(seed_points)
    total_seeds = sum(len(s) for s in seed_points.values())

    if method == "auto":
        if num_labels <= 1 or total_seeds < 10:
            method = "region_growing"
        else:
            method = "graph_cut"

    if method == "region_growing":
        return region_growing_segmentation(
            positions, normals, seed_points,
            k_neighbors=kwargs.get("k_neighbors", 12),
            similarity_threshold=kwargs.get("similarity_threshold", 0.3)
        )
    elif method == "graph_cut":
        return multi_label_graph_cut(
            positions, normals, seed_points,
            k_neighbors=kwargs.get("k_neighbors", 10),
            spatial_weight=kwargs.get("spatial_weight", 0.6),
            normal_weight=kwargs.get("normal_weight", 0.4)
        )
    else:
        return region_growing_segmentation(positions, normals, seed_points)
