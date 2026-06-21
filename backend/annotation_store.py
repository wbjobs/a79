import json
import redis
import time
import uuid
from typing import Dict, List, Optional, Any, Set
from dataclasses import dataclass, asdict, field


@dataclass
class User:
    user_id: str
    username: str
    color: str
    joined_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class PointAnnotation:
    point_index: int
    label: str
    user_id: str
    username: str
    user_color: str
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class LockInfo:
    lock_id: str
    point_index: int
    center_point: List[float]
    radius: float
    locked_points: List[int]
    user_id: str
    username: str
    user_color: str
    acquired_at: float
    expires_at: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ConflictLog:
    log_id: str
    model_name: str
    point_index: int
    requesting_user: Dict[str, str]
    existing_lock_user: Dict[str, str]
    timestamp: float
    conflict_type: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class AnnotationStore:
    def __init__(self, host: str = "localhost", port: int = 6379, db: int = 0):
        try:
            self.redis = redis.Redis(host=host, port=port, db=db, decode_responses=True)
            self.redis.ping()
            self.available = True
        except (redis.ConnectionError, Exception):
            print("Warning: Redis not available, using in-memory fallback")
            self.available = False
            self._memory: Dict[str, Any] = {}
            self._memory_sets: Dict[str, Set[str]] = {}
            self._memory_hashes: Dict[str, Dict[str, str]] = {}

    def _key(self, *parts: str) -> str:
        return ":".join(parts)

    def _get_set(self, key: str) -> Set[str]:
        if self.available:
            return set(self.redis.smembers(key) or [])
        return self._memory_sets.get(key, set())

    def _add_to_set(self, key: str, *values: str) -> int:
        if self.available:
            return self.redis.sadd(key, *values)
        if key not in self._memory_sets:
            self._memory_sets[key] = set()
        cnt = 0
        for v in values:
            if v not in self._memory_sets[key]:
                self._memory_sets[key].add(v)
                cnt += 1
        return cnt

    def _remove_from_set(self, key: str, *values: str) -> int:
        if self.available:
            return self.redis.srem(key, *values)
        if key not in self._memory_sets:
            return 0
        cnt = 0
        for v in values:
            if v in self._memory_sets[key]:
                self._memory_sets[key].remove(v)
                cnt += 1
        return cnt

    def _set_hash(self, key: str, mapping: Dict[str, Any]) -> bool:
        str_mapping = {k: json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in mapping.items()}
        if self.available:
            self.redis.hset(key, mapping=str_mapping)
            return True
        if key not in self._memory_hashes:
            self._memory_hashes[key] = {}
        self._memory_hashes[key].update(str_mapping)
        return True

    def _get_hash(self, key: str, field: Optional[str] = None) -> Any:
        if self.available:
            if field:
                val = self.redis.hget(key, field)
                if val is None:
                    return None
                try:
                    return json.loads(val)
                except (json.JSONDecodeError, ValueError):
                    return val
            result = self.redis.hgetall(key) or {}
            parsed = {}
            for k, v in result.items():
                try:
                    parsed[k] = json.loads(v)
                except (json.JSONDecodeError, ValueError):
                    parsed[k] = v
            return parsed
        if key not in self._memory_hashes:
            return {} if field is None else None
        if field:
            val = self._memory_hashes[key].get(field)
            if val is None:
                return None
            try:
                return json.loads(val)
            except (json.JSONDecodeError, ValueError):
                return val
        parsed = {}
        for k, v in self._memory_hashes[key].items():
            try:
                parsed[k] = json.loads(v)
            except (json.JSONDecodeError, ValueError):
                parsed[k] = v
        return parsed

    def _del_key(self, key: str) -> int:
        if self.available:
            return self.redis.delete(key)
        removed = 0
        for store in [self._memory, self._memory_sets, self._memory_hashes]:
            if key in store:
                del store[key]
                removed += 1
        return removed

    def _set_key(self, key: str, value: Any, ex: Optional[int] = None) -> bool:
        str_val = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
        if self.available:
            self.redis.set(key, str_val, ex=ex)
            return True
        self._memory[key] = str_val
        return True

    def _get_key(self, key: str) -> Any:
        if self.available:
            val = self.redis.get(key)
            if val is None:
                return None
            try:
                return json.loads(val)
            except (json.JSONDecodeError, ValueError):
                return val
        val = self._memory.get(key)
        if val is None:
            return None
        try:
            return json.loads(val)
        except (json.JSONDecodeError, ValueError):
            return val

    def add_user(self, model_name: str, user: User) -> bool:
        key = self._key("users", model_name)
        self._set_hash(key, {user.user_id: user.to_dict()})
        return True

    def remove_user(self, model_name: str, user_id: str) -> bool:
        key = self._key("users", model_name)
        if self.available:
            self.redis.hdel(key, user_id)
        else:
            if key in self._memory_hashes and user_id in self._memory_hashes[key]:
                del self._memory_hashes[key][user_id]
        return True

    def update_user(self, model_name: str, user: User) -> bool:
        user.last_active = time.time()
        return self.add_user(model_name, user)

    def get_users(self, model_name: str) -> List[User]:
        key = self._key("users", model_name)
        data = self._get_hash(key)
        users = []
        for uid, udata in data.items():
            if isinstance(udata, dict):
                users.append(User(
                    user_id=udata.get("user_id", uid),
                    username=udata.get("username", uid),
                    color=udata.get("color", "#ffffff"),
                    joined_at=udata.get("joined_at", time.time()),
                    last_active=udata.get("last_active", time.time())
                ))
        return users

    def add_tag(self, model_name: str, tag: str, color: str) -> bool:
        tags_key = self._key("tags", model_name)
        tag_colors_key = self._key("tag_colors", model_name)
        self._add_to_set(tags_key, tag)
        self._set_hash(tag_colors_key, {tag: color})
        return True

    def remove_tag(self, model_name: str, tag: str) -> bool:
        tags_key = self._key("tags", model_name)
        tag_colors_key = self._key("tag_colors", model_name)
        self._remove_from_set(tags_key, tag)
        if self.available:
            self.redis.hdel(tag_colors_key, tag)
        else:
            if tag_colors_key in self._memory_hashes and tag in self._memory_hashes[tag_colors_key]:
                del self._memory_hashes[tag_colors_key][tag]
        return True

    def get_tags(self, model_name: str) -> List[Dict[str, str]]:
        tags_key = self._key("tags", model_name)
        tag_colors_key = self._key("tag_colors", model_name)
        tags = sorted(self._get_set(tags_key))
        colors = self._get_hash(tag_colors_key)
        result = []
        for tag in tags:
            result.append({"name": tag, "color": colors.get(tag, "#4fc3f7")})
        return result

    def annotate_points(self, model_name: str, point_indices: List[int],
                        label: str, user: User) -> List[PointAnnotation]:
        annotations_key = self._key("annotations", model_name)
        label_set_key = self._key("label_points", model_name, label)
        user_label_key = self._key("user_label_points", model_name, user.user_id, label)
        user_all_key = self._key("user_points", model_name, user.user_id)

        annotations = []
        for idx in point_indices:
            ann = PointAnnotation(
                point_index=idx,
                label=label,
                user_id=user.user_id,
                username=user.username,
                user_color=user.color
            )
            self._set_hash(annotations_key, {str(idx): ann.to_dict()})
            self._add_to_set(label_set_key, str(idx))
            self._add_to_set(user_label_key, str(idx))
            self._add_to_set(user_all_key, str(idx))
            annotations.append(ann)
        return annotations

    def remove_annotation(self, model_name: str, point_index: int) -> bool:
        annotations_key = self._key("annotations", model_name)
        data = self._get_hash(annotations_key, str(point_index))
        if not data or not isinstance(data, dict):
            return False

        label = data.get("label", "")
        user_id = data.get("user_id", "")

        if self.available:
            self.redis.hdel(annotations_key, str(point_index))
        else:
            if annotations_key in self._memory_hashes and str(point_index) in self._memory_hashes[annotations_key]:
                del self._memory_hashes[annotations_key][str(point_index)]

        if label:
            label_set_key = self._key("label_points", model_name, label)
            self._remove_from_set(label_set_key, str(point_index))
        if user_id and label:
            user_label_key = self._key("user_label_points", model_name, user_id, label)
            self._remove_from_set(user_label_key, str(point_index))
        if user_id:
            user_all_key = self._key("user_points", model_name, user_id)
            self._remove_from_set(user_all_key, str(point_index))
        return True

    def get_annotation(self, model_name: str, point_index: int) -> Optional[PointAnnotation]:
        key = self._key("annotations", model_name)
        data = self._get_hash(key, str(point_index))
        if not data or not isinstance(data, dict):
            return None
        return PointAnnotation(
            point_index=data.get("point_index", point_index),
            label=data.get("label", ""),
            user_id=data.get("user_id", ""),
            username=data.get("username", ""),
            user_color=data.get("user_color", "#ffffff"),
            timestamp=data.get("timestamp", time.time())
        )

    def get_all_annotations(self, model_name: str) -> Dict[int, PointAnnotation]:
        key = self._key("annotations", model_name)
        data = self._get_hash(key)
        result = {}
        for idx_str, ann_data in data.items():
            if isinstance(ann_data, dict):
                try:
                    idx = int(idx_str)
                    result[idx] = PointAnnotation(
                        point_index=idx,
                        label=ann_data.get("label", ""),
                        user_id=ann_data.get("user_id", ""),
                        username=ann_data.get("username", ""),
                        user_color=ann_data.get("user_color", "#ffffff"),
                        timestamp=ann_data.get("timestamp", time.time())
                    )
                except ValueError:
                    continue
        return result

    def get_annotations_by_label(self, model_name: str, label: str) -> List[int]:
        key = self._key("label_points", model_name, label)
        points = self._get_set(key)
        return sorted([int(p) for p in points if p.lstrip('-').isdigit()])

    def get_annotations_by_user(self, model_name: str, user_id: str, label: Optional[str] = None) -> List[int]:
        if label:
            key = self._key("user_label_points", model_name, user_id, label)
        else:
            key = self._key("user_points", model_name, user_id)
        points = self._get_set(key)
        return sorted([int(p) for p in points if p.lstrip('-').isdigit()])

    def get_stats(self, model_name: str, total_points: int = 0) -> Dict[str, Any]:
        tags = self.get_tags(model_name)
        label_counts = {}
        user_counts = {}
        for tag in tags:
            pts = self.get_annotations_by_label(model_name, tag["name"])
            label_counts[tag["name"]] = len(pts)
        users = self.get_users(model_name)
        for user in users:
            pts = self.get_annotations_by_user(model_name, user.user_id)
            user_counts[user.user_id] = {
                "username": user.username,
                "color": user.color,
                "count": len(pts)
            }
        total_annotated = sum(label_counts.values())
        stats = {
            "total_points": total_points,
            "annotated_points": total_annotated,
            "unannotated_points": max(0, total_points - total_annotated),
            "annotation_rate": (total_annotated / total_points * 100) if total_points > 0 else 0,
            "label_counts": label_counts,
            "user_counts": user_counts,
            "num_users": len(users),
            "num_tags": len(tags)
        }
        return stats

    def _find_points_in_radius(self, positions: List[List[float]], center: List[float],
                               radius: float, exclude_indices: Optional[Set[int]] = None) -> List[int]:
        import numpy as np
        pos_arr = np.array(positions)
        center_arr = np.array(center)
        distances = np.linalg.norm(pos_arr - center_arr, axis=1)
        radius_m = radius / 100.0
        in_radius = np.where(distances <= radius_m)[0]
        result = [int(i) for i in in_radius]
        if exclude_indices:
            result = [i for i in result if i not in exclude_indices]
        return result

    def acquire_lock(self, model_name: str, point_index: int, center_point: List[float],
                     positions: List[List[float]], user: User,
                     radius: float = 1.0, ttl: int = 5) -> Optional[LockInfo]:
        radius_m = radius / 100.0
        locked_points = self._find_points_in_radius(positions, center_point, radius)
        locks_key = self._key("locks", model_name)
        now = time.time()
        expires_at = now + ttl
        lock_id = f"lock_{model_name}_{point_index}_{int(now * 1000)}"
        all_locks = self.get_all_locks(model_name)
        for existing_lock in all_locks.values():
            if existing_lock.expires_at < now:
                continue
            for p in locked_points:
                if p in existing_lock.locked_points:
                    conflict_log = ConflictLog(
                        log_id=f"conflict_{int(now * 1000)}_{uuid.uuid4().hex[:8]}",
                        model_name=model_name,
                        point_index=point_index,
                        requesting_user={"user_id": user.user_id, "username": user.username},
                        existing_lock_user={
                            "user_id": existing_lock.user_id,
                            "username": existing_lock.username
                        },
                        timestamp=now,
                        conflict_type="lock_overlap"
                    )
                    self._add_conflict_log(model_name, conflict_log)
                    return None
        lock_info = LockInfo(
            lock_id=lock_id,
            point_index=point_index,
            center_point=center_point,
            radius=radius,
            locked_points=locked_points,
            user_id=user.user_id,
            username=user.username,
            user_color=user.color,
            acquired_at=now,
            expires_at=expires_at
        )
        self._set_hash(locks_key, {str(point_index): lock_info.to_dict()})
        if self.available:
            self.redis.expire(self._key("locks", model_name), ttl + 10)
        return lock_info

    def release_lock(self, model_name: str, point_index: int, user_id: str) -> bool:
        locks_key = self._key("locks", model_name)
        existing = self.get_lock(model_name, point_index)
        if not existing:
            return False
        if existing.user_id != user_id:
            conflict_log = ConflictLog(
                log_id=f"conflict_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
                model_name=model_name,
                point_index=point_index,
                requesting_user={"user_id": user_id, "username": "unknown"},
                existing_lock_user={
                    "user_id": existing.user_id,
                    "username": existing.username
                },
                timestamp=time.time(),
                conflict_type="unauthorized_release"
            )
            self._add_conflict_log(model_name, conflict_log)
            return False
        if self.available:
            self.redis.hdel(locks_key, str(point_index))
        else:
            if locks_key in self._memory_hashes and str(point_index) in self._memory_hashes[locks_key]:
                del self._memory_hashes[locks_key][str(point_index)]
        return True

    def get_lock(self, model_name: str, point_index: int) -> Optional[LockInfo]:
        locks_key = self._key("locks", model_name)
        data = self._get_hash(locks_key, str(point_index))
        if not data or not isinstance(data, dict):
            return None
        lock_info = LockInfo(
            lock_id=data.get("lock_id", ""),
            point_index=data.get("point_index", point_index),
            center_point=data.get("center_point", [0, 0, 0]),
            radius=data.get("radius", 1.0),
            locked_points=data.get("locked_points", []),
            user_id=data.get("user_id", ""),
            username=data.get("username", ""),
            user_color=data.get("user_color", "#ff0000"),
            acquired_at=data.get("acquired_at", time.time()),
            expires_at=data.get("expires_at", time.time())
        )
        if lock_info.expires_at < time.time():
            return None
        return lock_info

    def get_all_locks(self, model_name: str) -> Dict[int, LockInfo]:
        locks_key = self._key("locks", model_name)
        data = self._get_hash(locks_key)
        result = {}
        now = time.time()
        for idx_str, lock_data in data.items():
            if isinstance(lock_data, dict):
                try:
                    idx = int(idx_str)
                    lock_info = LockInfo(
                        lock_id=lock_data.get("lock_id", ""),
                        point_index=idx,
                        center_point=lock_data.get("center_point", [0, 0, 0]),
                        radius=lock_data.get("radius", 1.0),
                        locked_points=lock_data.get("locked_points", []),
                        user_id=lock_data.get("user_id", ""),
                        username=lock_data.get("username", ""),
                        user_color=lock_data.get("user_color", "#ff0000"),
                        acquired_at=lock_data.get("acquired_at", now),
                        expires_at=lock_data.get("expires_at", now)
                    )
                    if lock_info.expires_at >= now:
                        result[idx] = lock_info
                except ValueError:
                    continue
        return result

    def is_point_locked(self, model_name: str, point_index: int,
                        exclude_user_id: Optional[str] = None) -> Optional[LockInfo]:
        all_locks = self.get_all_locks(model_name)
        for lock in all_locks.values():
            if exclude_user_id and lock.user_id == exclude_user_id:
                continue
            if point_index in lock.locked_points:
                return lock
        return None

    def _add_conflict_log(self, model_name: str, log: ConflictLog) -> bool:
        logs_key = self._key("conflict_logs", model_name)
        if self.available:
            self.redis.lpush(logs_key, json.dumps(log.to_dict()))
            self.redis.ltrim(logs_key, 0, 999)
        else:
            if logs_key not in self._memory:
                self._memory[logs_key] = []
            self._memory[logs_key].insert(0, json.dumps(log.to_dict()))
            if len(self._memory[logs_key]) > 1000:
                self._memory[logs_key] = self._memory[logs_key][:1000]
        print(f"[CONFLICT LOG] {log.to_dict()}")
        return True

    def get_conflict_logs(self, model_name: str, limit: int = 100) -> List[Dict[str, Any]]:
        logs_key = self._key("conflict_logs", model_name)
        if self.available:
            logs = self.redis.lrange(logs_key, 0, limit - 1) or []
        else:
            logs = self._memory.get(logs_key, [])[:limit]
        result = []
        for log_str in logs:
            try:
                result.append(json.loads(log_str))
            except (json.JSONDecodeError, TypeError):
                continue
        return result

    def clear_model_annotations(self, model_name: str) -> bool:
        pattern = self._key("*", model_name, "*")
        if self.available:
            keys = list(self.redis.scan_iter(match=pattern))
            simple_keys = [self._key("users", model_name),
                           self._key("tags", model_name),
                           self._key("tag_colors", model_name),
                           self._key("annotations", model_name),
                           self._key("locks", model_name),
                           self._key("conflict_logs", model_name)]
            for k in simple_keys:
                keys.append(k)
            for k in set(keys):
                self.redis.delete(k)
        return True


store = AnnotationStore()
